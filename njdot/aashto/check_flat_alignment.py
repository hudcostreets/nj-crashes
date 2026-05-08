#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "tqdm"]
# ///
"""For each row in Crash.csv, compute the *flat* length of every per-row
array column (i.e. recursively flatten nested lists) and check whether
columns that should reference the same entity agree.

Two reference dimensions:
  - PERSON: flat-len of `Person ID`
  - VEHICLE: outer-level length of `Person ID` (= number of vehicles in
    the crash). Equivalently: distinct values in flat `Unit ID`.

Per-column report: % of multi-person rows where flat_len matches
PERSON, matches VEHICLE, is 1 (scalar/crash-level), or matches
neither (anomaly).

Plus: per-row consistency check — within a single row, do all
'per-person' candidate columns agree with each other on flat length?
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from functools import partial
from pathlib import Path

import click
from tqdm import tqdm

err = partial(print, file=sys.stderr)


def flat(v):
    """Recursively flatten a nested list. Scalars become a single-element list."""
    if not isinstance(v, list):
        return [v]
    out = []
    for x in v:
        if isinstance(x, list):
            out.extend(flat(x))
        else:
            out.append(x)
    return out


def parse(s: str):
    if s == "" or s == "[object Undefined]":
        return None
    if s.startswith("[") and s.endswith("]"):
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return s
    return s


def outer_len(v):
    """Length of the OUTER array level. Returns 1 for scalars/non-lists."""
    if isinstance(v, list):
        return len(v)
    return 1


@click.command()
@click.option("-n", "--limit", type=int, help="Stop after N data rows")
@click.option("--show-anomalies", type=int, default=10, help="Show first N rows where col mismatches both PERSON and VEHICLE dims")
@click.argument("csv_path", type=click.Path(exists=True, path_type=Path))
def main(limit: int | None, show_anomalies: int, csv_path: Path):
    with open(csv_path, newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        header = next(rdr)
        idx = {c: i for i, c in enumerate(header)}
        ncols = len(header)

        person_id_idx = idx["Person ID"]
        unit_id_idx = idx["Unit ID"]
        agency_idx = idx["Agency ORI"]
        candidate_cols = list(range(0, agency_idx))  # per-person/per-vehicle range

        # Per-column: flat-len equals (PERSON, VEHICLE, 1=scalar, OTHER)
        cls_counts: list[Counter] = [Counter() for _ in range(ncols)]
        # Sample anomalies per column
        anomaly_samples: list[list] = [[] for _ in range(ncols)]
        # Per-row: ratio of flat lengths across "agreed-person" cols
        within_row_consistency = Counter()

        n = 0
        n_multi_person = 0
        for row_num, row in enumerate(tqdm(rdr, unit="row", desc=csv_path.name)):
            n += 1
            if len(row) != ncols:
                continue
            pid = parse(row[person_id_idx])
            person_dim = len(flat(pid))
            vehicle_dim = outer_len(pid)  # number of vehicles
            if person_dim <= 1:
                continue  # single-person crash; trivially consistent
            # Optionally: filter to rows where person_dim != vehicle_dim
            # so per-person and per-vehicle classifications are
            # disambiguable (toggle via env var to keep call sites
            # backward-compatible).
            import os
            if os.environ.get("DISAMBIGUATE") and person_dim == vehicle_dim:
                continue
            n_multi_person += 1

            row_lens = {}
            for ci in candidate_cols:
                if ci == person_id_idx:
                    continue
                v_raw = row[ci]
                if v_raw == "":
                    cls_counts[ci]["empty"] += 1
                    continue
                v = parse(v_raw)
                fl = len(flat(v))
                row_lens[ci] = fl
                if fl == person_dim:
                    cls_counts[ci]["person"] += 1
                elif fl == vehicle_dim:
                    cls_counts[ci]["vehicle"] += 1
                elif fl == 1:
                    cls_counts[ci]["scalar"] += 1
                else:
                    cls_counts[ci]["other"] += 1
                    if len(anomaly_samples[ci]) < show_anomalies:
                        anomaly_samples[ci].append({
                            "row": row_num,
                            "person_dim": person_dim,
                            "vehicle_dim": vehicle_dim,
                            "flat_len": fl,
                            "raw_short": (v_raw[:80] + "...") if len(v_raw) > 80 else v_raw,
                        })

            if limit and n >= limit:
                break

    err(f"\nScanned {n:,} rows ({n_multi_person:,} multi-person)")

    # Categorize columns
    per_person_cols = []
    per_vehicle_cols = []
    crash_scalar_cols = []
    mixed_cols = []

    for ci in candidate_cols:
        if ci == person_id_idx:
            continue
        c = cls_counts[ci]
        total = c["person"] + c["vehicle"] + c["scalar"] + c["other"]
        if total == 0:
            continue
        ppct = c["person"] / total
        vpct = c["vehicle"] / total
        spct = c["scalar"] / total
        opct = c["other"] / total

        cat = None
        if ppct >= 0.95:
            cat = "PERSON"
            per_person_cols.append((ci, header[ci], ppct))
        elif vpct >= 0.95:
            cat = "VEHICLE"
            per_vehicle_cols.append((ci, header[ci], vpct))
        elif spct >= 0.95:
            cat = "CRASH-scalar (misclassified)"
            crash_scalar_cols.append((ci, header[ci], spct))
        else:
            cat = "MIXED"
            mixed_cols.append((ci, header[ci], ppct, vpct, spct, opct))

    print(f"\n=== Per-PERSON columns ({len(per_person_cols)}, ≥95% match Person dim) ===")
    for ci, name, p in sorted(per_person_cols, key=lambda r: -r[2]):
        print(f"  {name:40s}  person={p*100:5.1f}%")

    print(f"\n=== Per-VEHICLE columns ({len(per_vehicle_cols)}, ≥95% match Vehicle dim) ===")
    for ci, name, p in sorted(per_vehicle_cols, key=lambda r: -r[2]):
        print(f"  {name:40s}  vehicle={p*100:5.1f}%")

    print(f"\n=== CRASH-level scalar columns leaking into per-person range ({len(crash_scalar_cols)}) ===")
    for ci, name, p in sorted(crash_scalar_cols, key=lambda r: -r[2]):
        print(f"  {name:40s}  scalar={p*100:5.1f}%")

    print(f"\n=== MIXED columns (no clear category) ({len(mixed_cols)}) ===")
    print(f"  {'col':40s}  {'pers%':>6s} {'veh%':>6s} {'scal%':>6s} {'other%':>6s}")
    for ci, name, pp, vp, sp, op in sorted(mixed_cols, key=lambda r: -r[2]):
        print(f"  {name:40s}  {pp*100:5.1f}% {vp*100:5.1f}% {sp*100:5.1f}% {op*100:5.1f}%")

    print(f"\n=== Anomalies (first 5 cols with most 'other' mismatches) ===")
    by_other = sorted(
        [(ci, header[ci], cls_counts[ci]["other"]) for ci in candidate_cols],
        key=lambda r: -r[2],
    )[:5]
    for ci, name, n_other in by_other:
        if n_other == 0:
            continue
        print(f"\n  {name} ({n_other} anomalies):")
        for s in anomaly_samples[ci][:5]:
            print(f"    row {s['row']:6d}  person_dim={s['person_dim']:3d}  vehicle_dim={s['vehicle_dim']:2d}  flat_len={s['flat_len']:3d}  {s['raw_short']}")


if __name__ == "__main__":
    main()
