#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow"]
# ///
"""Supplement AASHTO crashes with NJSP-only fatals (AASHTO ingestion lag)
and per-crash VTC (victim-type × condition) counts.

AASHTO 2025 has a fatal-classification lag concentrated in specific
counties (Monmouth, Mercer, Essex etc.) — fatal status takes time to
propagate (death-cert / 30-day rule), while injury/PDO records arrive
on schedule. NJSP carries the up-to-date fatal classifications, so we
back-fill the 111 NJSP-only-2025 fatals into the AASHTO output to keep
the homepage NJDOT plot honest until AASHTO catches up.

Also computes 25-column VTC matrix (`df`/`ds`/.../`un`) from the AASHTO
person supplements so `agg.py` can emit per-VT aggregations for AASHTO
years, matching the legacy master crashes parquet. NJSP-supplement rows
land in the `uf` bucket (driver/passenger/ped/cyclist breakdown not
available at residual granularity).

Removable: when a fresh `Crash.csv` shows AASHTO in sync with NJSP,
delete this step from the pipeline.

Reads:
  - njdot/data/aashto_combined_crashes.parquet (pure AASHTO, schema-mapped)
  - njsp/data/njsp_njdot_residuals.parquet     (NJSP-side residuals from match_njdot)
  - njdot/data/aashto_supplemented_occupants.parquet  (for VTC, optional)
  - njdot/data/aashto_supplemented_pedestrians.parquet (for VTC, optional)

Writes:
  - njdot/data/aashto_supplemented_crashes.parquet
"""
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd

err = partial(print, file=sys.stderr)

# VTC matrix: 5 victim types × 5 conditions = 25 columns
VICTIM_TYPES = ['d', 'o', 'p', 'b', 'u']  # driver, passenger, pedestrian, bicyclist, unknown
CONDITIONS = ['f', 's', 'm', 'p', 'n']     # fatal, serious, minor, possible, none
VTC_COLS = [f'{vt}{c}' for vt in VICTIM_TYPES for c in CONDITIONS]
CONDITION_MAP = {1: 'f', 2: 's', 3: 'm', 4: 'p', 5: 'n', 0: 'n'}
CRASH_PK = ['year', 'cc', 'mc', 'case']


def _pos_to_vt(pos):
    if pd.isna(pos) or pos == 0:
        return 'u'
    return 'd' if pos == 1 else 'o'


def compute_vtc(occupants: pd.DataFrame, pedestrians: pd.DataFrame) -> pd.DataFrame:
    """Compute 25-col VTC matrix aggregated by (year, cc, mc, case).

    Inputs are AASHTO-supplemented O/P frames with `condition` (Int 1-5),
    `pos` (occupants, 1=driver / 2-12=passenger), `cyclist` (peds).
    Returns a DataFrame indexed by CRASH_PK with VTC_COLS columns (int).
    """
    o = occupants.copy()
    o['cond'] = o['condition'].map(CONDITION_MAP).fillna('n')
    o['vt'] = o['pos'].apply(_pos_to_vt)
    o['vtc'] = o['vt'] + o['cond']

    p = pedestrians.copy()
    p['cond'] = p['condition'].map(CONDITION_MAP).fillna('n')
    p['vt'] = p['cyclist'].apply(lambda b: 'b' if b else 'p')
    p['vtc'] = p['vt'] + p['cond']

    parts = []
    for df in (o, p):
        if not len(df):
            continue
        agg = df.groupby(CRASH_PK + ['vtc']).size().unstack(fill_value=0)
        parts.append(agg)
    if not parts:
        return pd.DataFrame(columns=CRASH_PK + VTC_COLS).set_index(CRASH_PK)

    combined = parts[0]
    for extra in parts[1:]:
        combined = combined.add(extra, fill_value=0)
    for col in VTC_COLS:
        if col not in combined.columns:
            combined[col] = 0
    combined = combined[VTC_COLS].fillna(0).astype(int)
    return combined


@click.command()
@click.option("-a", "--aashto", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_combined_crashes.parquet"))
@click.option("-r", "--residuals", type=click.Path(path_type=Path),
              default=Path("njsp/data/njsp_njdot_residuals.parquet"))
@click.option("-O", "--occupants-supplement", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_supplemented_occupants.parquet"))
@click.option("-P", "--pedestrians-supplement", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_supplemented_pedestrians.parquet"))
@click.option("-o", "--out", type=click.Path(path_type=Path),
              default=Path("njdot/data/aashto_supplemented_crashes.parquet"))
def main(aashto: Path, residuals: Path, occupants_supplement: Path,
         pedestrians_supplement: Path, out: Path):
    a = pd.read_parquet(aashto)
    aashto_years = sorted(a["year"].dropna().astype(int).unique())
    err(f"AASHTO: {len(a):,} crashes, years {aashto_years[0]}–{aashto_years[-1]}")

    res = pd.read_parquet(residuals)
    sp_only = res[(res["side"] == "njsp") & res["year"].isin(aashto_years)].copy()
    err(f"NJSP-side residuals in AASHTO years: {len(sp_only)} "
        f"({sp_only['tk'].sum()} deaths)")
    if len(sp_only):
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
        n_supplemented = len(supp)
    else:
        out_df = a.copy()
        n_supplemented = 0

    # VTC enrichment from person supplements
    if occupants_supplement.exists() and pedestrians_supplement.exists():
        err(f"\nComputing VTC from {occupants_supplement.name} + {pedestrians_supplement.name}…")
        occ = pd.read_parquet(occupants_supplement)
        ped = pd.read_parquet(pedestrians_supplement)
        err(f"  loaded {len(occ):,} occupants + {len(ped):,} pedestrians")
        vtc = compute_vtc(occ, ped).reset_index()
        # Align dtypes for merge (out_df has Int8/Int16 for cc/mc; vtc has Int8/Int16 too via supplements)
        out_df = out_df.merge(vtc, on=CRASH_PK, how='left')
        for col in VTC_COLS:
            out_df[col] = out_df[col].fillna(0).astype('int8')
        # NJSP-supplemented rows: each row's tk into `uf` (we don't know VT
        # breakdown for residual fatals). cc/mc nullable issues left as-is.
        is_njsp_supp = out_df['case'].astype(str).str.startswith('NJSP-supplement-')
        if is_njsp_supp.any():
            out_df.loc[is_njsp_supp, 'uf'] = out_df.loc[is_njsp_supp, 'tk'].astype('int8')
            err(f"  marked {is_njsp_supp.sum()} NJSP-supplement rows with uf={out_df.loc[is_njsp_supp, 'uf'].sum()}")
        err(f"  total VTC fatals (df+of+pf+bf+uf): "
            f"{int(out_df[['df','of','pf','bf','uf']].sum().sum()):,}")
    else:
        err(f"  Person supplements not found; VTC columns omitted "
            f"({occupants_supplement.name}, {pedestrians_supplement.name})")

    out.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_parquet(out, index=False)
    err(f"Wrote {out} ({len(out_df):,} crashes; +{n_supplemented} from NJSP)")

    # Quick verification: post-supplement fatals per year
    fa = out_df[out_df["severity"] == "f"]
    err("\nFatal counts by year (post-supplement):")
    for y in sorted(fa["year"].dropna().astype(int).unique()):
        sub = fa[fa["year"] == y]
        err(f"  {y}: {len(sub):4d} fatal-crashes, {int(sub['tk'].sum()):4d} deaths")


if __name__ == "__main__":
    main()
