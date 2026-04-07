"""
Utilities for handling duplicate records across all entity types.

Provides consistent duplicate detection, analysis, and side-output writing
for crashes, vehicles, occupants, pedestrians, and drivers.
"""
import pandas as pd
from pathlib import Path
from typing import Optional

from nj_crashes.utils.log import err


def analyze_and_write_dupes(
    df: pd.DataFrame,
    pk_cols: list[str],
    entity_name: str,
    year: int,
    output_base: Optional[str] = None,
    write_outputs: bool = False,
) -> tuple[pd.DataFrame, dict]:
    """
    Analyze duplicates and optionally write side-output files.

    Args:
        df: DataFrame with potential duplicates
        pk_cols: Primary key columns
        entity_name: Entity type name (e.g., "vehicles", "occupants")
        year: Year being processed
        output_base: Base output directory (default: njdot/data/{year}/{entity_name}_dupes)
        write_outputs: Whether to write side-output files

    Returns:
        (dupes_df, stats) where:
        - dupes_df: DataFrame with duplicate records and metadata
        - stats: Dictionary with duplicate statistics
    """
    # Find duplicates
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        return None, {
            'total': len(df),
            'num_dupes': 0,
            'num_groups': 0,
            'full_dupes': 0,
            'pk_only_dupes': 0,
        }

    num_dupes = dupe_mask.sum()
    dupes = df[dupe_mask].copy()

    # Count full duplicates
    full_dupe_mask = df.duplicated(keep=False)
    full_dupes = full_dupe_mask.sum()

    # Add metadata
    dupes['lineno'] = dupes.index + 2  # Original line number (1-based + header)

    # Group by PK and add group index
    grouped = dupes.groupby(pk_cols, sort=False)
    num_groups = len(grouped)

    # Add group_idx and idx (position within group)
    group_records = []
    for group_idx, (pk, group) in enumerate(grouped):
        for idx, (_, row) in enumerate(group.iterrows()):
            rec = row.copy()
            rec['group_idx'] = group_idx
            rec['idx'] = idx
            group_records.append(rec)

    dupes_df = pd.DataFrame(group_records)

    # Statistics
    stats = {
        'total': len(df),
        'num_dupes': num_dupes,
        'num_groups': num_groups,
        'full_dupes': full_dupes,
        'pk_only_dupes': num_dupes - full_dupes,
    }

    # Log summary
    err(f"{entity_name} {year}: Found {num_dupes:,} duplicate records ({num_groups:,} groups)")
    err(f"  Full duplicates: {full_dupes:,}, PK-only: {stats['pk_only_dupes']:,}")

    # Write side outputs if requested
    if write_outputs:
        if output_base is None:
            output_base = f'njdot/data/{year}/{entity_name}_dupes'

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
            if len(idx_df) > 0:
                idx_path = unmerged_dir / f'{idx}.pqt'
                idx_df.to_parquet(idx_path, index=False)

        # Write group size distribution
        group_sizes = dupes_df.groupby('group_idx').size()
        size_dist = group_sizes.value_counts().sort_index()
        err(f"  Group size distribution:")
        for size, count in size_dist.items():
            err(f"    Size {size}: {count:,} groups")

    return dupes_df, stats


def drop_duplicates_with_analysis(
    df: pd.DataFrame,
    pk_cols: list[str],
    entity_name: str,
    year: int,
    keep: str = 'first',
    write_side_outputs: bool = False,
) -> pd.DataFrame:
    """
    Drop duplicates with logging and optional side-output writing.

    This is a drop-in replacement for df.drop_duplicates() that adds:
    - Detailed logging of duplicate statistics
    - Optional side-output files for manual inspection

    Args:
        df: DataFrame with potential duplicates
        pk_cols: Primary key columns
        entity_name: Entity type name
        year: Year being processed
        keep: Which duplicate to keep ('first', 'last', False)
        write_side_outputs: Whether to write duplicate analysis files

    Returns:
        DataFrame with duplicates removed
    """
    before = len(df)

    # Analyze and optionally write side outputs
    dupes_df, stats = analyze_and_write_dupes(
        df, pk_cols, entity_name, year,
        write_outputs=write_side_outputs,
    )

    # Drop duplicates
    if stats['num_dupes'] > 0:
        # First drop full duplicates
        df_deduped = df.drop_duplicates(keep=keep)
        full_dupes_dropped = before - len(df_deduped)

        # Then drop duplicate keys
        df = df_deduped.drop_duplicates(subset=pk_cols, keep=keep)
        after = len(df)
        key_dupes_dropped = len(df_deduped) - after

        if full_dupes_dropped > 0 or key_dupes_dropped > 0:
            err(f"{entity_name} {year}: Dropped {full_dupes_dropped:,} full + {key_dupes_dropped:,} key = {before - after:,} total duplicates")

    return df
