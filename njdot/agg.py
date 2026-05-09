#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "click",
#     "pandas",
#     "pyarrow",
# ]
# ///
"""
Aggregate NJDOT crash data into small parquet files for frontend visualization.

Generates aggregations like:
- ymccs: year, month, county, severity → counts/injuries/fatalities
- yms: year, month, severity → state-level totals
- etc.

Output files go to www/public/data/njdot/ for hyparquet to load.
"""

from functools import reduce
from pathlib import Path

import click
import pandas as pd


# Dimension columns
DIMS = {
    'y': 'year',
    'm': 'month',
    'cc': 'cc',
    'mc': 'mc',
    's': 'severity',
}

# Victim type × condition matrix columns
VICTIM_TYPES = ['d', 'o', 'p', 'b', 'u']  # driver, passenger, pedestrian, bicyclist, unknown
CONDITIONS = ['f', 's', 'm', 'p', 'n']     # fatal, serious, minor, possible, none
VTC_COLS = [f'{vt}{c}' for vt in VICTIM_TYPES for c in CONDITIONS]

# Measure columns (aggregations)
# Include victim type × condition matrix (25 columns) for frontend filtering/stacking
MEASURES = ['n', 'tk', 'ti', 'pk', 'pi', 'tv'] + VTC_COLS


def load_crashes(path: Path) -> pd.DataFrame:
    """Load crashes parquet and add month column."""
    import pyarrow.parquet as pq
    schema_cols = set(pq.read_schema(path).names)
    base_cols = ['year', 'cc', 'mc', 'dt', 'severity', 'tk', 'ti', 'pk', 'pi', 'tv']
    vtc_present = [c for c in VTC_COLS if c in schema_cols]
    if vtc_present:
        print(f"  VTC columns found: {len(vtc_present)}/{len(VTC_COLS)}")
    else:
        print(f"  No VTC columns in {path.name}, using basic measures only")
    df = pd.read_parquet(path, columns=base_cols + vtc_present)
    df['month'] = pd.to_datetime(df['dt']).dt.month
    df['n'] = 1  # count column
    for c in VTC_COLS:
        if c not in df.columns:
            df[c] = 0
    return df


BASE_MEASURES = ['n', 'tk', 'ti', 'pk', 'pi', 'tv']


def aggregate(df: pd.DataFrame, dims: list[str]) -> pd.DataFrame:
    """Aggregate crashes by given dimensions."""
    group_cols = [DIMS[d] for d in dims]
    agg_df = df.groupby(group_cols, as_index=False)[MEASURES].sum()
    # Rename columns to short names
    rename = {v: k for k, v in DIMS.items() if v in group_cols}
    agg_df = agg_df.rename(columns=rename)
    # Drop VTC columns that are all zero (not present in source data)
    for c in VTC_COLS:
        if c in agg_df.columns and (agg_df[c] == 0).all():
            agg_df = agg_df.drop(columns=[c])
    # Downcast numeric columns for smaller parquet files
    for c in agg_df.columns:
        if c in ('s',):
            continue
        if agg_df[c].dtype in ('int64', 'float64'):
            col_max = agg_df[c].max()
            if agg_df[c].dtype == 'float64' and (agg_df[c] == agg_df[c].astype(int)).all():
                agg_df[c] = agg_df[c].astype('int64')
            if col_max <= 127:
                agg_df[c] = agg_df[c].astype('int8')
            elif col_max <= 32767:
                agg_df[c] = agg_df[c].astype('int16')
            elif col_max <= 2147483647:
                agg_df[c] = agg_df[c].astype('int32')
    return agg_df


def write_parquet(df: pd.DataFrame, path: Path):
    """Write aggregation to parquet with snappy compression (hyparquet-compatible)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False, compression='snappy')
    size_kb = path.stat().st_size / 1024
    print(f"  {path.name}: {len(df):,} rows, {size_kb:.1f} KB, {len(df.columns)} cols")


def parse_dims(agg_name: str) -> list[str]:
    """Parse dimension codes from aggregation name.

    Handles multi-char codes like 'cc', 'mc'.
    E.g., 'ymccs' -> ['y', 'm', 'cc', 's']
    """
    dims = []
    i = 0
    while i < len(agg_name):
        # Check for two-char codes first
        if i + 1 < len(agg_name):
            two_char = agg_name[i:i+2]
            if two_char in DIMS:
                dims.append(two_char)
                i += 2
                continue
        # Single char
        dims.append(agg_name[i])
        i += 1
    return dims


# Predefined aggregation configs: name -> dimension list
AGG_CONFIGS = {
    'ys': ['y', 's'],                      # year, severity (state totals)
    'yms': ['y', 'm', 's'],                # year, month, severity
    'yccs': ['y', 'cc', 's'],              # year, county, severity
    'ymccs': ['y', 'm', 'cc', 's'],        # year, month, county, severity
    'ymccmc': ['y', 'm', 'cc', 'mc'],      # year, month, county, muni (most granular, no severity)
    'ymccmcs': ['y', 'm', 'cc', 'mc', 's'], # year, month, county, muni, severity (largest)
}


@click.command()
@click.option('-i', '--input', 'input_path', default='njdot/data/crashes.parquet', help='Input crashes parquet (per-table 2001–2023)')
@click.option('-A', '--aashto-input', default='njdot/data/aashto_supplemented_crashes.parquet', help='AASHTO crashes parquet (with NJSP-only fatals supplemented in)')
@click.option('-o', '--output-dir', default='www/public/data/njdot', help='Output directory')
@click.option('-a', '--aggs', default='ys,yms,yccs,ymccs,ymccmc,ymccmcs', help='Comma-separated list of aggregations to generate')
def main(input_path: str, aashto_input: str, output_dir: str, aggs: str):
    """Generate aggregated parquet files for NJDOT crash data."""
    input_path = Path(input_path)
    aashto_input = Path(aashto_input)
    output_dir = Path(output_dir)

    print(f"Loading {input_path}...")
    df = load_crashes(input_path)
    print(f"  {len(df):,} crashes loaded ({df['year'].min()}-{df['year'].max()})")

    if aashto_input.exists():
        print(f"Loading {aashto_input}...")
        aashto_df = load_crashes(aashto_input)
        print(f"  {len(aashto_df):,} crashes loaded ({aashto_df['year'].min()}-{aashto_df['year'].max()})")
        # Drop rows with cc/mc unresolved (small percentage; can't be
        # bucketed into per-county/per-muni aggregates).
        n_drop = aashto_df['cc'].isna().sum()
        if n_drop:
            print(f"  dropping {n_drop:,} AASHTO rows with unresolved (cc, mc)")
            aashto_df = aashto_df.dropna(subset=['cc'])
        # Prefer AASHTO over per-table for any overlapping year — per-table
        # 2023 has a broad-vs-strict-fatal mismatch (severity='f' uses
        # broad def, tk uses strict), producing an impossible 0.93
        # deaths/fatal-crash ratio. AASHTO uses Fatal Crash Indicator
        # (NJSP-aligned).
        aashto_years = set(aashto_df['year'].dropna().astype(int))
        overlap = sorted(set(df['year'].dropna().astype(int)) & aashto_years)
        if overlap:
            print(f"  AASHTO supersedes per-table for: {overlap}")
            df = df[~df['year'].isin(aashto_years)]
        df = pd.concat([df, aashto_df], ignore_index=True)
        print(f"  combined: {len(df):,} crashes ({df['year'].min()}-{df['year'].max()})")
    else:
        print(f"  (no AASHTO input at {aashto_input}; skipping 2024+)")

    agg_list = [a.strip() for a in aggs.split(',')]

    print(f"\nGenerating {len(agg_list)} aggregations...")
    for agg_name in agg_list:
        if agg_name not in AGG_CONFIGS:
            print(f"  {agg_name}: unknown aggregation (available: {', '.join(AGG_CONFIGS.keys())})")
            continue
        dims = AGG_CONFIGS[agg_name]
        try:
            agg_df = aggregate(df, dims)
            # Split municipality-level files by county for faster loading
            if 'mc' in dims:
                county_dir = output_dir / agg_name
                county_dir.mkdir(parents=True, exist_ok=True)
                for cc_val in sorted(agg_df['cc'].unique()):
                    cc_df = agg_df[agg_df['cc'] == cc_val].drop(columns=['cc'])
                    write_parquet(cc_df, county_dir / f"{cc_val}.parquet")
                total_kb = sum(f.stat().st_size for f in county_dir.glob('*.parquet')) / 1024
                print(f"  {agg_name}/: {len(agg_df):,} rows total, {total_kb:.1f} KB across {len(agg_df['cc'].unique())} counties")
            else:
                write_parquet(agg_df, output_dir / f"{agg_name}.parquet")
        except KeyError as e:
            print(f"  {agg_name}: error {e}")

    print("\nDone!")


if __name__ == '__main__':
    main()
