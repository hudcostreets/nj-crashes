#!/usr/bin/env -S uv run --quiet --script
# /// script
# dependencies = [
#   "pandas",
#   "pyarrow",
# ]
# ///
"""
Write duplicate records to side-output files for manual inspection/analysis.

For each entity type with duplicates, writes:
- merged.pqt: Records from duplicate groups (with metadata)
- unmerged/*.pqt: Split by position within group (0.pqt, 1.pqt, etc.)

This formalizes the pattern used for crashes in njdot/data/2023/crash_dupes/.
"""
import pandas as pd
import sys
from functools import partial
from pathlib import Path

err = partial(print, file=sys.stderr)


def write_dupe_outputs(
    df: pd.DataFrame,
    pk_cols: list[str],
    entity_name: str,
    year: int,
    output_base: str = None,
):
    """
    Write duplicate records to side-output directory.

    Args:
        df: DataFrame with potential duplicates
        pk_cols: Primary key columns
        entity_name: Entity type name (e.g., "vehicles", "occupants")
        year: Year being processed
        output_base: Base output directory (default: njdot/data/{year}/{entity_name}_dupes)
    """
    if output_base is None:
        output_base = f'njdot/data/{year}/{entity_name}_dupes'

    # Find duplicates
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        err(f"{entity_name}: No duplicates found")
        return

    num_dupes = dupe_mask.sum()
    dupes = df[dupe_mask].copy()

    # Add metadata
    dupes['lineno'] = dupes.index + 2  # Original line number (1-based + header)

    # Group by PK and add group index
    grouped = dupes.groupby(pk_cols, sort=False)
    num_groups = len(grouped)

    err(f"\n{entity_name}:")
    err(f"  Total duplicate records: {num_dupes:,}")
    err(f"  Duplicate groups: {num_groups:,}")

    # Add group_idx and idx (position within group)
    group_records = []
    for group_idx, (pk, group) in enumerate(grouped):
        for idx, (_, row) in enumerate(group.iterrows()):
            rec = row.copy()
            rec['group_idx'] = group_idx
            rec['idx'] = idx
            group_records.append(rec)

    dupes_df = pd.DataFrame(group_records)

    # Create output directory
    output_dir = Path(output_base)
    output_dir.mkdir(parents=True, exist_ok=True)
    unmerged_dir = output_dir / 'unmerged'
    unmerged_dir.mkdir(exist_ok=True)

    # Write all merged records
    merged_path = output_dir / 'merged.pqt'
    dupes_df.to_parquet(merged_path, index=False)
    err(f"  Wrote {merged_path}: {len(dupes_df):,} records")

    # Write split by position
    max_idx = int(dupes_df['idx'].max())
    for idx in range(max_idx + 1):
        idx_df = dupes_df[dupes_df['idx'] == idx]
        idx_path = unmerged_dir / f'{idx}.pqt'
        idx_df.to_parquet(idx_path, index=False)
        err(f"  Wrote {idx_path}: {len(idx_df):,} records (position {idx})")

    # Write group size distribution
    group_sizes = dupes_df.groupby('group_idx').size()
    size_dist = group_sizes.value_counts().sort_index()
    err(f"\n  Group size distribution:")
    for size, count in size_dist.items():
        err(f"    Size {size}: {count:,} groups")


def load_raw_2023(entity_type: str) -> pd.DataFrame:
    """Load raw 2023 parquet before deduplication."""
    path = f'njdot/data/2023/NewJersey2023{entity_type}.pqt'
    return pd.read_parquet(path)


def main():
    year = 2023
    err(f"Writing duplicate outputs for {year} data...")

    # Load raw data
    crashes = load_raw_2023('Accidents')
    vehicles = load_raw_2023('Vehicles')
    occupants = load_raw_2023('Occupants')
    pedestrians = load_raw_2023('Pedestrians')
    drivers = load_raw_2023('Drivers')

    # Define primary keys
    crash_pk = ['County Code', 'Municipality Code', 'Department Case Number']
    vehicle_pk = crash_pk + ['Vehicle Number']
    occupant_pk = vehicle_pk + ['Occupant Number']
    pedestrian_pk = crash_pk + ['Pedestrian Number']
    driver_pk = vehicle_pk  # Drivers should have unique (crash, vehicle) keys

    # Write outputs for each entity
    # Note: Crashes already have outputs via njdot/merge_2023_dupes.py
    # But we can write simpler versions here for consistency

    write_dupe_outputs(vehicles, vehicle_pk, 'vehicles', year)
    write_dupe_outputs(occupants, occupant_pk, 'occupants', year)
    write_dupe_outputs(pedestrians, pedestrian_pk, 'pedestrians', year)
    write_dupe_outputs(drivers, driver_pk, 'drivers', year)

    err("\nDone!")


if __name__ == '__main__':
    main()
