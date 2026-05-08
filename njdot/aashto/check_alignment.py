#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "tqdm"]
# ///
"""For each row in Crash.csv, compute the (outer, inner_len) shape of
each per-person column relative to `Person ID`'s shape. Report:
  - rows where shapes match (good)
  - rows where shapes mismatch (problem)
  - rows where Person ID is scalar (single-person crashes — trivially fine)
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


def shape(v):
    """Compute the shape signature of a parsed value:
       - scalar → ('s', 1)
       - 1D list of length n → ('a', n)
       - 2D nested list with inner lengths [m1, m2, ...] → ('a2', tuple([m1,m2,...]))
       - Else → ('?', None)"""
    if not isinstance(v, list):
        return ("s", 1)
    if all(not isinstance(x, list) for x in v):
        return ("a", len(v))
    return ("a2", tuple(len(x) if isinstance(x, list) else 1 for x in v))


def parse(s: str):
    if s == "" or s == "[object Undefined]":
        return None
    if s.startswith("[") and s.endswith("]"):
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return s
    return s


@click.command()
@click.option("-n", "--limit", type=int, help="Stop after N data rows")
@click.option("--multi-only/--all-rows", default=True, help="Only check rows where Person ID is non-scalar")
@click.argument("csv_path", type=click.Path(exists=True, path_type=Path))
def main(limit: int | None, multi_only: bool, csv_path: Path):
    with open(csv_path, newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        header = next(rdr)
        idx = {c: i for i, c in enumerate(header)}

        person_id_idx = idx["Person ID"]
        # Per-person columns: every column index < idx["Agency ORI"]
        # but excluding obvious vehicle-only ones (Unit ID, Vehicle Make,
        # Vehicle Color, etc.).  We'll just compare every leading-half
        # column against Person ID's shape.
        agency_idx = idx["Agency ORI"]
        per_person_or_vehicle_cols = list(range(0, agency_idx))

        # Per-column tally: shapes-match-PersonID, shapes-mismatch-PersonID, was-empty
        match = Counter()
        mismatch = Counter()
        empty = Counter()
        scalar_pk = 0
        multi = 0
        n = 0

        for row in tqdm(rdr, unit="row", desc=csv_path.name):
            n += 1
            pid_raw = row[person_id_idx]
            pid = parse(pid_raw)
            pid_shape = shape(pid)
            if pid_shape == ("s", 1):
                scalar_pk += 1
                if multi_only:
                    if limit and n >= limit:
                        break
                    continue
            multi += 1
            for ci in per_person_or_vehicle_cols:
                if ci == person_id_idx:
                    continue
                v_raw = row[ci]
                if v_raw == "":
                    empty[ci] += 1
                    continue
                v = parse(v_raw)
                if shape(v) == pid_shape:
                    match[ci] += 1
                else:
                    mismatch[ci] += 1
            if limit and n >= limit:
                break

    err(f"\nScanned {n:,} rows ({multi:,} multi-person, {scalar_pk:,} single-person)")

    # Top mismatchers vs Person ID
    rows = []
    for ci in per_person_or_vehicle_cols:
        if ci == person_id_idx:
            continue
        m, mm, e = match[ci], mismatch[ci], empty[ci]
        total_nonempty = m + mm
        if total_nonempty == 0:
            continue
        rows.append((header[ci], m, mm, e, m / total_nonempty))

    print(f"{'col':40s}\t{'match':>8s}\t{'mismatch':>8s}\t{'empty':>8s}\t{'match%':>8s}")
    for name, m, mm, e, pct in sorted(rows, key=lambda r: r[4]):
        print(f"{name:40s}\t{m:>8d}\t{mm:>8d}\t{e:>8d}\t{pct*100:>7.1f}%")


if __name__ == "__main__":
    main()
