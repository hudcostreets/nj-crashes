#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow"]
# ///
"""Supplement AASHTO crashes with NJSP-only fatals (AASHTO ingestion lag).

AASHTO 2025 has a fatal-classification lag concentrated in specific
counties (Middlesex, Hudson, Essex etc.) — fatal status takes time to
propagate (death-cert / 30-day rule), while injury/PDO records arrive
on schedule. NJSP carries the up-to-date fatal classifications, so we
back-fill the 111 NJSP-only-2025 fatals into the AASHTO output to keep
the homepage NJDOT plot honest until AASHTO catches up.

Removable: when a fresh `Crash.csv` shows AASHTO in sync with NJSP,
delete this step from the pipeline.

Reads:
  - njdot/data/aashto_combined_crashes.parquet (pure AASHTO, schema-mapped)
  - njsp/data/njsp_njdot_residuals.parquet     (NJSP-side residuals from match_njdot)

Writes:
  - njdot/data/aashto_supplemented_crashes.parquet
"""
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd

err = partial(print, file=sys.stderr)


@click.command()
@click.option("-a", "--aashto", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_combined_crashes.parquet"))
@click.option("-r", "--residuals", type=click.Path(path_type=Path),
              default=Path("njsp/data/njsp_njdot_residuals.parquet"))
@click.option("-o", "--out", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_supplemented_crashes.parquet"))
def main(aashto: Path, residuals: Path, out: Path):
    a = pd.read_parquet(aashto)
    aashto_years = sorted(a["year"].dropna().astype(int).unique())
    err(f"AASHTO: {len(a):,} crashes, years {aashto_years[0]}–{aashto_years[-1]}")

    res = pd.read_parquet(residuals)
    sp_only = res[(res["side"] == "njsp") & res["year"].isin(aashto_years)].copy()
    err(f"NJSP-side residuals in AASHTO years: {len(sp_only)} "
        f"({sp_only['tk'].sum()} deaths)")
    if not len(sp_only):
        a.to_parquet(out, index=False)
        err(f"No supplement needed; copied AASHTO → {out}")
        return

    # Build AASHTO-schema rows from NJSP residuals. Only fields that matter
    # for downstream `agg.py` (year, cc, mc, severity, tk, ti, pk, pi, tv).
    # `case` carries an `NJSP-{i}` synthetic id for provenance.
    supp = pd.DataFrame({
        "year": sp_only["year"].astype("int32").values,
        "cc": sp_only["cc"].astype("Int8").values,
        "mc": sp_only["mc"].astype("Int16").values,
        "case": [f"NJSP-supplement-{i}" for i in range(len(sp_only))],
        # Use date as datetime (no time-of-day in residuals)
        "dt": pd.to_datetime(sp_only["date"]).values,
        "severity": pd.array(["f"] * len(sp_only), dtype="string"),
        "tk": sp_only["tk"].astype("int8").values,
        "tk_broad": sp_only["tk"].astype("int8").values,
        "ti": pd.array([0] * len(sp_only), dtype="int8"),
        "pk": pd.array([0] * len(sp_only), dtype="int8"),
        "pi": pd.array([0] * len(sp_only), dtype="int8"),
        "tv": pd.array([0] * len(sp_only), dtype="int8"),
        "cc0": sp_only["cc"].astype("Int8").values,
        "mc0": sp_only["mc"].astype("Int16").values,
    })
    # Add any AASHTO columns not yet set, as nulls.
    for col in a.columns:
        if col not in supp.columns:
            supp[col] = pd.NA
    supp = supp[a.columns]

    out_df = pd.concat([a, supp], ignore_index=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_parquet(out, index=False)
    err(f"Wrote {out} ({len(out_df):,} crashes; +{len(supp)} from NJSP)")

    # Quick verification: post-supplement fatals per year
    fa = out_df[out_df["severity"] == "f"]
    err("\nFatal counts by year (post-supplement):")
    for y in sorted(fa["year"].dropna().astype(int).unique()):
        sub = fa[fa["year"] == y]
        err(f"  {y}: {len(sub):4d} fatal-crashes, {int(sub['tk'].sum()):4d} deaths")


if __name__ == "__main__":
    main()
