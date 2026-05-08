#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "tqdm", "utz"]
# ///
"""Probe an AASHTO `Crash.csv` to see whether per-Person / per-Vehicle
columns can be UNPIVOTed back into separate tables.

For each column, characterize:
  - how often the cell is a scalar vs JSON-array
  - distribution of array lengths
  - presence of nested arrays (`[[a,b], c]`)
  - presence of the literal string `[object Undefined]`

Then for each row, compute the dominant array length per *group of
columns* (we don't know the groupings yet — we infer them by checking
which columns tend to share array length within a given row).

Output: per-column TSV stats + a sample of a few rows' shape signatures.
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

UNDEFINED_MARKER = "[object Undefined]"


def parse_cell(s: str):
    """Return (kind, payload) where kind is one of:
       'empty', 'scalar', 'array', 'array-nested', 'undefined-literal'.
       payload is a list (for arrays) or the raw string (for scalars).
       Nested arrays are flagged but not recursively descended."""
    if s == "":
        return "empty", None
    if s == UNDEFINED_MARKER:
        return "undefined-literal", s
    # JSON arrays in this CSV start with `[` and end with `]`. We only
    # JSON-parse cells that look array-shaped; everything else is scalar.
    if s.startswith("[") and s.endswith("]"):
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            return "scalar", s
        if not isinstance(v, list):
            return "scalar", s
        nested = any(isinstance(x, list) for x in v)
        return ("array-nested" if nested else "array"), v
    return "scalar", s


@click.command()
@click.option("-n", "--limit", type=int, help="Stop after N data rows")
@click.option("-o", "--out", type=click.Path(path_type=Path), default=Path("tmp/crash-csv-probe.tsv"))
@click.option("-s", "--sample-rows", type=int, default=10, help="Print this many sample rows' shape signatures")
@click.argument("csv_path", type=click.Path(exists=True, path_type=Path))
def main(limit: int | None, out: Path, sample_rows: int, csv_path: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        header = next(rdr)
        ncols = len(header)
        err(f"{csv_path}: {ncols} columns")

        # Per-column counters
        kind_counts: list[Counter] = [Counter() for _ in range(ncols)]
        array_lens: list[Counter] = [Counter() for _ in range(ncols)]
        undefined_in_arrays: list[int] = [0] * ncols
        nonempty: list[int] = [0] * ncols

        # Per-row: collect array-length signature for the first few rows
        signatures = []

        size = csv_path.stat().st_size
        pbar = tqdm(rdr, unit="row", total=None, desc=csv_path.name)
        n = 0
        for row in pbar:
            if len(row) != ncols:
                err(f"  row {n}: {len(row)} cols (expected {ncols}); skipping")
                continue
            n += 1
            row_sig = {}
            for i, cell in enumerate(row):
                kind, payload = parse_cell(cell)
                kind_counts[i][kind] += 1
                if kind != "empty":
                    nonempty[i] += 1
                if kind in ("array", "array-nested"):
                    array_lens[i][len(payload)] += 1
                    if any(x == UNDEFINED_MARKER for x in payload if isinstance(x, str)):
                        undefined_in_arrays[i] += 1
                    if i in row_sig:
                        pass  # shouldn't happen
                    row_sig[i] = (len(payload), kind == "array-nested")
            if len(signatures) < sample_rows:
                signatures.append(row_sig)
            if limit and n >= limit:
                break

        err(f"\nScanned {n:,} rows.")

    # Write per-column TSV
    with open(out, "w") as f:
        f.write("\t".join([
            "col_idx", "name", "n_nonempty",
            "scalar_pct", "array_pct", "nested_pct", "empty_pct", "undef_lit_pct",
            "array_len_top5", "n_rows_with_undef_in_array",
        ]) + "\n")
        for i, name in enumerate(header):
            kc = kind_counts[i]
            total = sum(kc.values())
            ne = nonempty[i]
            top5 = ", ".join(f"{k}:{v}" for k, v in array_lens[i].most_common(5))
            row = [
                str(i + 1),
                name,
                str(ne),
                f"{kc.get('scalar', 0) / total:.3f}",
                f"{kc.get('array', 0) / total:.3f}",
                f"{kc.get('array-nested', 0) / total:.3f}",
                f"{kc.get('empty', 0) / total:.3f}",
                f"{kc.get('undefined-literal', 0) / total:.3f}",
                top5,
                str(undefined_in_arrays[i]),
            ]
            f.write("\t".join(row) + "\n")
    err(f"per-column stats → {out}")

    # Print row-shape signatures: for each sampled row, report the
    # set of distinct array lengths and which columns share each length.
    err("\nRow-shape signatures (cols grouped by array length):")
    for ri, sig in enumerate(signatures):
        len_to_cols = defaultdict(list)
        for col_idx, (alen, nested) in sig.items():
            len_to_cols[alen].append(col_idx + 1)
        err(f"  row {ri}: {sum(1 for _ in sig)} array cells")
        for alen, cols in sorted(len_to_cols.items()):
            sample = ", ".join(header[c - 1].strip('"') for c in cols[:5])
            more = f" + {len(cols)-5} more" if len(cols) > 5 else ""
            err(f"    len={alen}: {len(cols)} cols [{sample}{more}]")


if __name__ == "__main__":
    main()
