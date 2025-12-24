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

# Measure columns (aggregations)
MEASURES = ['n', 'tk', 'ti', 'pk', 'pi', 'tv']


def load_crashes(path: Path) -> pd.DataFrame:
    """Load crashes parquet and add month column."""
    df = pd.read_parquet(
        path,
        columns=['year', 'cc', 'mc', 'dt', 'severity', 'tk', 'ti', 'pk', 'pi', 'tv'],
    )
    df['month'] = pd.to_datetime(df['dt']).dt.month
    df['n'] = 1  # count column
    return df


def aggregate(df: pd.DataFrame, dims: list[str]) -> pd.DataFrame:
    """Aggregate crashes by given dimensions."""
    group_cols = [DIMS[d] for d in dims]
    agg_df = df.groupby(group_cols, as_index=False)[MEASURES].sum()
    # Rename columns to short names
    rename = {v: k for k, v in DIMS.items() if v in group_cols}
    agg_df = agg_df.rename(columns=rename)
    return agg_df


def write_parquet(df: pd.DataFrame, path: Path):
    """Write aggregation to parquet with snappy compression (hyparquet-compatible)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False, compression='snappy')
    size_kb = path.stat().st_size / 1024
    print(f"  {path.name}: {len(df):,} rows, {size_kb:.1f} KB")


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
@click.option('-i', '--input', 'input_path', default='njdot/data/crashes.parquet', help='Input crashes parquet')
@click.option('-o', '--output-dir', default='www/public/data/njdot', help='Output directory')
@click.option('-a', '--aggs', default='ys,yms,yccs,ymccs', help='Comma-separated list of aggregations to generate')
def main(input_path: str, output_dir: str, aggs: str):
    """Generate aggregated parquet files for NJDOT crash data."""
    input_path = Path(input_path)
    output_dir = Path(output_dir)

    print(f"Loading {input_path}...")
    df = load_crashes(input_path)
    print(f"  {len(df):,} crashes loaded")

    agg_list = [a.strip() for a in aggs.split(',')]

    print(f"\nGenerating {len(agg_list)} aggregations...")
    for agg_name in agg_list:
        if agg_name not in AGG_CONFIGS:
            print(f"  {agg_name}: unknown aggregation (available: {', '.join(AGG_CONFIGS.keys())})")
            continue
        dims = AGG_CONFIGS[agg_name]
        try:
            agg_df = aggregate(df, dims)
            write_parquet(agg_df, output_dir / f"{agg_name}.parquet")
        except KeyError as e:
            print(f"  {agg_name}: error {e}")

    print("\nDone!")


if __name__ == '__main__':
    main()
