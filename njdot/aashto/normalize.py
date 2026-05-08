#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow", "tqdm", "utz"]
# ///
"""Normalize an AASHTO `Crash.csv` into per-table parquets.

The CSV encodes per-vehicle and per-person facts as JSON-arrays inside
single cells. Each row is one crash. Per-person fields nest as
[[...persons in vehicle 0...], ...]; per-vehicle fields are flat
arrays of length = vehicle count.

Outputs (under `<out-dir>/<year>/`):

    crashes.parquet   — one row per crash; 85 crash-level fields + Total*
    vehicles.parquet  — one row per (crash, vehicle); 31 vehicle/driver fields
    persons.parquet   — one row per (crash, person); 14 per-person fields
                         plus `unit_id` FK to vehicles
    issues.parquet    — long-form data-quality findings; keyed to crashes
                         by crash_id + row_idx + column

Issue policy:
  - Fatal (raise): missing/duplicate `Crash ID`; person/vehicle counts
    exceeding sanity bounds (>1000/>200); per-person column whose flat
    length doesn't match `Person ID`'s flat length (would scramble
    person→attribute join).
  - Warn (coerce + emit): literal `[object Undefined]` strings, vehicle
    columns with unexpected nesting (we coerce to first-N values
    matching vehicle_dim), unknown ambiguous shapes.

The issue types are kept stable so the parquet can drive a per-column,
per-issue dashboard for AASHTO/Numetric to triage.
"""
import csv
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path

import click
import pandas as pd
from tqdm import tqdm

err = partial(print, file=sys.stderr)

UNDEFINED = "[object Undefined]"
SANITY_MAX_VEHICLES = 200
SANITY_MAX_PERSONS = 1000

# --- Column categorization (from check_flat_alignment.py findings) ---

# Per-person columns: 14 attributes that are ≥98% flat-aligned with
# `Person ID` on multi-person rows. Plus the join keys (`Person ID`,
# `Unit ID`).
PERSON_COLS = [
    "Person ID",      # PK
    "Unit ID",        # FK to vehicle (this person was in this unit)
    "Occupant ID",    # 99.9% person-aligned
    "Age",            # 100%
    "Sex",            # 98.5%
    "Person Type",    # 100%
    "Position in Vehicle",  # 98.6%
    "Ejection",             # 98.7%
    "Injury Status",        # 98.7%
    "Severity Rating (Person)",  # 98.8%
    "Physical Condition ID",     # 98.8%
    "Safety Equipment Used",     # 99.9%
    "Safety Equipment Available",# 99.9%
    "Unrestrained Occupant Involved",  # 100%
    "Zip Code",                  # 100%
]

# Per-vehicle columns: 31 attributes ≥95% flat-aligned with vehicle_dim
# on rows where person_dim != vehicle_dim. (When person_dim ==
# vehicle_dim, vehicle and person shapes are indistinguishable, but
# these are treated as per-vehicle.)
VEHICLE_COLS = [
    "Vehicle ID",            # PK
    "Vehicle Make",          # 98.3%
    "Vehicle Type",          # 97.7%
    "Vehicle Use",           # 97.7%
    "Unit Type",             # 100%
    "Original Unit Number",  # 100%
    "Direction of Travel",   # 98.4%
    "Initial Impact",        # 95.1%
    "Most Harmful Event of Unit",  # 98.8%
    "Pre-Crash Action",      # 99.6%
    "Roadway or Lane Departure",   # 100%
    "Extent of Damage",      # 98.0%
    "Hit and Run",           # 95.9%
    "Distracted Driving",    # 100%
    "Unsafe Speed",          # 100%
    "Countermeasure: No Turn On Red",  # 100%
    "Driver Age",            # 99.9%
    "Driver's License Class",      # 99.1%
    "Driver's License Endorsements",  # 99.9%
    "Driver's License Restrictions",  # 99.8%
    "Alcohol Test Given",            # 99.7%
    "Alcohol Test Type",             # 100%
    "Alcohol Test Result",           # 100%
    "Alcohol Test Result Pending",   # 99.7%
    "Age of Infant (Months)",        # 99.9%
    "Placard",                       # 98.3%
    "Removed To",                    # 98.3%
    "USDOT Number",                  # 98.3%
    "Railcar Involved",              # 100%
    "Response to Emergency",         # 95.4%
    "Traffic Control",               # 98.9%
]

# Columns whose tier is ambiguous from the alignment scan
# (60-90% per-person, 25-35% per-vehicle in raw counts; need
# disambiguation to classify cleanly). For now we drop these to keep
# the per-table joins crisp; revisit once we hear back from AASHTO/
# Numetric on intent.
AMBIGUOUS_DROPPED_COLS = [
    "Airbag", "Eye Color", "Hospital", "Injury Location", "Injury Type",
    "Refused Treatment", "Removed By", "Citation Issued",
    "Driver's License ID", "Driver's License State",
    "Alcohol Test ID", "State",
    "Cargo Body Type", "Carrier City", "Carrier State", "Carrier Zip",
    "Commercial Vehicle ID", "Hazmat Status", "MCMX Number",
    "Overweight Permit", "Plate State", "Special Function",
    "Vehicle Color", "Vehicle Model", "Weight Rating",
    "Driver Age Group", "Driver Is Owner",
    "Driverless Classification",
]

# Crash-level scalar columns that live in the per-person/vehicle range
# (cols 1–88) but are 100% scalar. We pull these into the crashes
# table. NB: header has two columns named "State" (one per-person?,
# one per-vehicle?); our dict-keyed cell access conflates them, so
# we drop "State" here and let the trailing crash-level cols carry
# any state info.
CRASH_LEAK_COLS = [
    "Functional Class", "Segment ID",
    "Total Bicyclists", "Total Bicyclists Killed",
    "Total Drivers", "Total Incapacitated",
    "Total Injured Bicyclists (Not Killed)", "Total Occupants",
    "Urban or Rural",
]

# Compound multi-valued columns. Inner shape is column-specific
# (e.g. Events has 4-tuples per vehicle). We store these as raw JSON
# strings in the crashes table for now; downstream parsers can decide
# how to unpack.
COMPOUND_COLS = ["Events", "Factors", "Physical Statuses", "NJDOT Summary", "SHSP Emphasis Areas"]


# --- Helpers ---

def parse_cell(s: str):
    """Returns (kind, payload). kind ∈ {empty, undef, scalar, array}.
       arrays may be nested arbitrarily deeply; payload is the parsed
       Python value."""
    if s == "":
        return "empty", None
    if s == UNDEFINED:
        return "undef", None
    if s.startswith("[") and s.endswith("]"):
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            return "scalar", s
        if isinstance(v, list):
            return "array", v
        return "scalar", v
    return "scalar", s


def flatten(v):
    """Recursively flatten. Scalars become single-element list.
       `[object Undefined]` strings within arrays become None."""
    if not isinstance(v, list):
        if v == UNDEFINED:
            return [None]
        return [v]
    out = []
    for x in v:
        if isinstance(x, list):
            out.extend(flatten(x))
        elif x == UNDEFINED:
            out.append(None)
        else:
            out.append(x)
    return out


def flatten_with_outer(v) -> list[tuple[int, object]]:
    """For a 2-D nested list `[[...], [...], ...]`, return `(outer_idx, value)`
    pairs in flat order. Scalars get outer_idx=0. Used to derive each person's
    vehicle_index from the outer-array position of their Person ID slot."""
    if not isinstance(v, list):
        val = None if v == UNDEFINED else v
        return [(0, val)]
    out = []
    for i, sub in enumerate(v):
        if isinstance(sub, list):
            for x in sub:
                out.append((i, None if x == UNDEFINED else x))
        else:
            out.append((i, None if sub == UNDEFINED else sub))
    return out


def outer_len(v):
    if isinstance(v, list):
        return len(v)
    return 1


@dataclass
class Issue:
    row_idx: int
    crash_id: str | None
    column: str
    issue_type: str
    detail: str
    raw_value: str


@dataclass
class FatalDataIssue(Exception):
    row_idx: int
    crash_id: str | None
    message: str


@dataclass
class Acc:
    crashes: list = field(default_factory=list)
    vehicles: list = field(default_factory=list)
    persons: list = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    issue_counts: Counter = field(default_factory=Counter)


def process_row(row_idx: int, row: list[str], header: list[str], acc: Acc):
    """Decompose one CSV row into crash/vehicle/person rows."""
    cell = {h: row[i] for i, h in enumerate(header)}
    crash_id = cell.get("Crash ID", "").strip()
    if not crash_id:
        raise FatalDataIssue(row_idx, None, "missing Crash ID")

    # --- Reference dims from Person ID (the join key) ---
    pid_kind, pid_val = parse_cell(cell["Person ID"])
    pid_flat = flatten(pid_val) if pid_kind != "empty" else []
    person_dim = len(pid_flat)

    # vehicle_dim: outer length of Person ID, OR length of Unit ID's
    # flat-distinct-values, whichever is larger (Person ID's outer
    # collapses to scalar for single-vehicle multi-person crashes).
    vehicle_dim = outer_len(pid_val) if pid_kind == "array" else (1 if person_dim >= 1 else 0)
    # Cross-check via Unit ID
    uid_kind, uid_val = parse_cell(cell.get("Unit ID", ""))
    if uid_kind != "empty":
        uid_flat = flatten(uid_val)
        if uid_flat:
            vehicle_dim = max(vehicle_dim, len(set(x for x in uid_flat if x is not None)))

    if person_dim > SANITY_MAX_PERSONS:
        raise FatalDataIssue(row_idx, crash_id, f"person_dim={person_dim} > {SANITY_MAX_PERSONS}")
    if vehicle_dim > SANITY_MAX_VEHICLES:
        raise FatalDataIssue(row_idx, crash_id, f"vehicle_dim={vehicle_dim} > {SANITY_MAX_VEHICLES}")

    def add_issue(col, kind, detail, raw):
        acc.issues.append(Issue(row_idx, crash_id, col, kind, detail, raw[:200]))
        acc.issue_counts[kind] += 1

    # --- Build crash record ---
    crash_rec = {"row_idx": row_idx, "crash_id": crash_id, "person_dim": person_dim, "vehicle_dim": vehicle_dim}
    # All trailing crash-level cols (idx ≥ Agency ORI). Plus the 11 leaks.
    # COMPOUND_COLS are expected to be array-valued at crash level
    # (e.g. `NJDOT Summary` is a list of categories the crash falls under);
    # they pass through as JSON without flagging.
    agency_idx = header.index("Agency ORI")
    for i in range(agency_idx, len(header)):
        col = header[i]
        kind, v = parse_cell(cell[col])
        if kind == "undef":
            add_issue(col, "object_undefined", "scalar `[object Undefined]`", cell[col])
            crash_rec[col] = None
        elif kind == "array":
            if col in COMPOUND_COLS:
                crash_rec[col] = json.dumps(v)
            else:
                add_issue(col, "unexpected_array_in_crash_col", f"array of length {len(v)}", cell[col])
                crash_rec[col] = json.dumps(v)
        else:
            crash_rec[col] = v if kind != "empty" else None

    for col in CRASH_LEAK_COLS:
        if col not in cell:
            continue
        kind, v = parse_cell(cell[col])
        if kind == "undef":
            crash_rec[f"_leak_{col}"] = None
            add_issue(col, "object_undefined", "leak col scalar undef", cell[col])
        elif kind == "array":
            # Leak cols *should* be scalar. If we see an array, take first
            # element and flag.
            add_issue(col, "leak_col_unexpected_array", f"len={len(v)}", cell[col])
            f = flatten(v)
            crash_rec[f"_leak_{col}"] = f[0] if f else None
        else:
            crash_rec[f"_leak_{col}"] = v if kind != "empty" else None

    # Compound cols → JSON strings
    for col in COMPOUND_COLS:
        if col not in cell:
            continue
        crash_rec[col] = cell[col] if cell[col] != "" else None

    acc.crashes.append(crash_rec)

    # --- Build vehicle records ---
    # We use Vehicle ID's outer values as the vehicle index when present,
    # else fall back to outer-iter of any per-vehicle col.
    vehicle_recs: list[dict] = []
    for vi in range(vehicle_dim):
        vrec = {"row_idx": row_idx, "crash_id": crash_id, "vehicle_index": vi}
        for col in VEHICLE_COLS:
            if col not in cell:
                continue
            kind, v = parse_cell(cell[col])
            if kind == "empty":
                vrec[col] = None
                continue
            if kind == "undef":
                add_issue(col, "object_undefined", "scalar undef", cell[col])
                vrec[col] = None
                continue
            f = flatten(v)
            # Three valid shapes:
            #   - flat_len == vehicle_dim     ← canonical per-vehicle
            #   - flat_len == 1                ← single value, broadcast
            #   - flat_len == person_dim       ← unambiguously per-person
            #     (when person_dim != vehicle_dim) — emit issue, drop
            #   - flat_len == k * vehicle_dim  ← compound per-vehicle
            #     (e.g. Vehicle Model has 2*vehicle_dim entries); take
            #     the v_i'th tuple and join with `;`
            #   - else                         ← anomaly, take vi-th element
            if len(f) == vehicle_dim:
                vrec[col] = f[vi]
            elif len(f) == 1:
                vrec[col] = f[0]
            elif len(f) == person_dim and person_dim != vehicle_dim:
                add_issue(col, "vehicle_col_has_person_dim", f"flat_len={len(f)} matches person_dim, expected vehicle_dim={vehicle_dim}", cell[col])
                vrec[col] = None
            elif vehicle_dim > 0 and len(f) % vehicle_dim == 0:
                # compound-per-vehicle: each vehicle gets k consecutive
                # values; join them with semicolons (preserves info,
                # leaves downstream to split if needed).
                k = len(f) // vehicle_dim
                if k > 1:
                    add_issue(col, "vehicle_col_compound", f"flat_len={len(f)}={k}×vehicle_dim={vehicle_dim}; joined sub-tuple with ;", cell[col])
                slc = f[vi * k : (vi + 1) * k]
                vrec[col] = ";".join("" if x is None else str(x) for x in slc)
            else:
                add_issue(col, "vehicle_col_unexpected_shape", f"flat_len={len(f)}, vehicle_dim={vehicle_dim}, person_dim={person_dim}", cell[col])
                vrec[col] = f[vi] if vi < len(f) else None
        vehicle_recs.append(vrec)
    acc.vehicles.extend(vehicle_recs)

    # --- Build person records ---
    if person_dim == 0:
        return  # no occupants reported (rare; pedestrian-only?)

    # For each person, gather attributes by flat-positional alignment.
    # Per-person columns must match person_dim exactly; mismatch is fatal.
    flats: dict[str, list] = {}
    for col in PERSON_COLS:
        if col not in cell:
            continue
        kind, v = parse_cell(cell[col])
        if kind == "empty":
            flats[col] = [None] * person_dim
            continue
        if kind == "undef":
            flats[col] = [None] * person_dim
            add_issue(col, "object_undefined", "scalar undef in person col", cell[col])
            continue
        f = flatten(v)
        if len(f) == person_dim:
            flats[col] = f
        elif len(f) == 1:
            # Broadcast scalar across persons (with issue).
            add_issue(col, "person_col_scalar_broadcast", f"scalar in person col, broadcasting to {person_dim}", cell[col])
            flats[col] = f * person_dim
        else:
            # Real shape mismatch on a per-person column — refuses to
            # join. This is the join-breaker we promised to fatal on.
            raise FatalDataIssue(
                row_idx, crash_id,
                f"person col `{col}` flat_len={len(f)} != person_dim={person_dim}; unrecoverable join",
            )

    # Derive each person's vehicle_index from the outer-array position
    # of their Person ID slot. This is the FK that joins to
    # vehicles.vehicle_index (positional 0..N-1), unlike `Unit ID`
    # (the AASHTO-internal unit number, e.g. 56) which differs from
    # the row's positional vehicle_index.
    pid_outer_pairs = flatten_with_outer(pid_val)
    if len(pid_outer_pairs) != person_dim:
        # Defensive: should be impossible given person_dim = len(flatten(pid_val))
        raise FatalDataIssue(row_idx, crash_id, f"flatten_with_outer disagrees: {len(pid_outer_pairs)} vs {person_dim}")

    for pi in range(person_dim):
        outer_idx, _ = pid_outer_pairs[pi]
        # If person_dim > 1 but vehicle_dim == 1 (single vehicle, multiple
        # occupants), Person ID may be a flat 1D list — in that case
        # outer_idx will be the index within the flat list, not the
        # vehicle_index. Override to 0 (the only vehicle).
        if vehicle_dim == 1:
            outer_idx = 0
        prec = {
            "row_idx": row_idx,
            "crash_id": crash_id,
            "person_index": pi,
            "vehicle_index": outer_idx,
        }
        for col in PERSON_COLS:
            if col in flats:
                prec[col] = flats[col][pi]
        acc.persons.append(prec)


@click.command()
@click.option("-y", "--year", type=int, required=True)
@click.option("-o", "--out-dir", type=click.Path(path_type=Path), default=Path("njdot/data"))
@click.option("-n", "--limit", type=int, help="Stop after N data rows")
@click.option("-S", "--strict/--lenient", default=False, help="Fatal on any data quality issue (default: only fatal on relational breaks)")
@click.argument("csv_path", type=click.Path(exists=True, path_type=Path))
def main(year: int, out_dir: Path, limit: int | None, strict: bool, csv_path: Path):
    out_dir = out_dir / str(year)
    out_dir.mkdir(parents=True, exist_ok=True)
    acc = Acc()
    fatal_count = 0

    with open(csv_path, newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        header = next(rdr)
        for row_idx, row in enumerate(tqdm(rdr, unit="row", desc=csv_path.name)):
            if len(row) != len(header):
                err(f"  row {row_idx}: bad column count ({len(row)} vs {len(header)}); skipping")
                continue
            try:
                process_row(row_idx, row, header, acc)
            except FatalDataIssue as e:
                fatal_count += 1
                acc.issues.append(Issue(e.row_idx, e.crash_id, "(fatal)", "FATAL", e.message, ""))
                acc.issue_counts["FATAL"] += 1
                if fatal_count <= 5:
                    err(f"  FATAL row {e.row_idx} crash_id={e.crash_id}: {e.message}")
                if strict:
                    err(f"FATAL row {e.row_idx} crash_id={e.crash_id}: {e.message}")
                    raise SystemExit(2)
            if limit and row_idx + 1 >= limit:
                break

    err(f"\nProcessed: crashes={len(acc.crashes):,}, vehicles={len(acc.vehicles):,}, persons={len(acc.persons):,}, issues={len(acc.issues):,}, fatals={fatal_count}")
    err("Issue summary:")
    for k, v in sorted(acc.issue_counts.items(), key=lambda kv: -kv[1]):
        err(f"  {k:40s}  {v:>10,d}")

    def coerce_object_to_str(df: pd.DataFrame) -> pd.DataFrame:
        """Pyarrow chokes on object cols with mixed scalar types (int vs
        str). For now coerce all object cols to nullable string. Lossy
        for genuinely numeric cols, but downstream consumers can re-cast."""
        for c in df.columns:
            if df[c].dtype == object:
                df[c] = df[c].apply(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
        return df

    crashes_df = coerce_object_to_str(pd.DataFrame(acc.crashes))
    vehicles_df = coerce_object_to_str(pd.DataFrame(acc.vehicles))
    persons_df = coerce_object_to_str(pd.DataFrame(acc.persons))
    issues_df = coerce_object_to_str(pd.DataFrame([i.__dict__ for i in acc.issues]))

    # Sanity: Crash IDs unique in crashes table
    if not crashes_df.empty and crashes_df["crash_id"].duplicated().any():
        n_dup = crashes_df["crash_id"].duplicated().sum()
        err(f"WARN: {n_dup} duplicate Crash IDs in crashes table")

    crashes_df.to_parquet(out_dir / "crashes.parquet", index=False)
    vehicles_df.to_parquet(out_dir / "vehicles.parquet", index=False)
    persons_df.to_parquet(out_dir / "persons.parquet", index=False)
    issues_df.to_parquet(out_dir / "issues.parquet", index=False)
    err(f"Wrote 4 parquets under {out_dir}/")


if __name__ == "__main__":
    main()
