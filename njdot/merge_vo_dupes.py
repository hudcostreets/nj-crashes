"""
Smart merge strategy for vehicle and occupant duplicates.

Key insight: V/O duplicates exist because crashes have duplicates. Each crash
version (UCASE/TCASE) has its own V/O records. We can trace V/O records back
to their source crash using line number ordering, then preferentially keep
records from TCASE crashes (the geocoded/updated version).

Strategy:
1. For V/O pairs in UCASE/TCASE crash pairs: keep the one from TCASE
2. For other duplicates: keep first (fallback)
"""
import pandas as pd
from typing import Optional

from nj_crashes.utils.log import err


def load_crash_version_map(crash_dupes_path: str = 'njdot/data/2023/crash_dupes/merged.pqt') -> dict:
    """
    Load crash duplicate metadata and classify crashes as UCASE/TCASE.

    Returns dict mapping (cc, mc, case) -> list of (lineno, case_class) sorted by lineno
    """
    crash_dupes = pd.read_parquet(crash_dupes_path)

    # Classify crashes
    text_fields = ['Police Department', 'Crash Location', 'Cross Street Name']

    def classify_case(row):
        upper_count = 0
        mixed_count = 0
        total_fields = 0

        for field in text_fields:
            val = row[field]
            if pd.isna(val) or val == '':
                continue
            s = str(val)
            total_fields += 1
            if s.isupper():
                upper_count += 1
            elif any(c.isupper() for c in s):
                mixed_count += 1

        if total_fields == 0:
            return 'neither'
        if upper_count / total_fields > 0.5:
            return 'ucase'
        elif mixed_count / total_fields > 0.5:
            return 'tcase'
        else:
            return 'neither'

    crash_dupes['case_class'] = crash_dupes.apply(classify_case, axis=1)

    # Build map: crash PK -> sorted list of (lineno, case_class)
    crash_key_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    crash_map = {}

    for _, row in crash_dupes.iterrows():
        pk = tuple(row[crash_key_cols])
        if pk not in crash_map:
            crash_map[pk] = []
        crash_map[pk].append((row['lineno'], row['case_class']))

    # Sort by line number
    for pk in crash_map:
        crash_map[pk] = sorted(crash_map[pk], key=lambda x: x[0])

    return crash_map


def merge_vo_duplicates(
    df: pd.DataFrame,
    pk_cols: list[str],
    entity_name: str,
    year: int = 2023,
    crash_map: Optional[dict] = None,
) -> pd.DataFrame:
    """
    Merge V/O duplicates using crash version information.

    For pairs in UCASE/TCASE crashes: keep record from TCASE (better version)
    For other duplicates: keep first (fallback)

    Args:
        df: DataFrame with potential duplicates (must have original index)
        pk_cols: Primary key columns
        entity_name: 'vehicles' or 'occupants'
        year: Year being processed
        crash_map: Pre-loaded crash version map (optional, will load if None)

    Returns:
        DataFrame with duplicates resolved
    """
    # Find duplicates
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        return df

    if crash_map is None:
        crash_map = load_crash_version_map()

    num_dupes = dupe_mask.sum()
    dupes = df[dupe_mask].copy()
    non_dupes = df[~dupe_mask].copy()

    # Use preserved line numbers from load.py (added before index reset)
    if '_orig_lineno' not in dupes.columns:
        err(f"WARNING: {entity_name} {year}: No _orig_lineno column found, smart merge will fail")
        return df
    dupes['lineno'] = dupes['_orig_lineno']

    # Group by PK
    grouped = dupes.groupby(pk_cols, sort=False)
    num_groups = len(grouped)

    err(f"{entity_name} {year}: Merging {num_dupes:,} duplicates ({num_groups:,} groups)")

    merged_records = []
    tcase_kept = 0
    fallback_kept = 0

    crash_key_cols = ['County Code', 'Municipality Code', 'Department Case Number']

    for pk, group in grouped:
        if len(group) == 2:
            # Check if this is in a UCASE/TCASE crash pair
            r0, r1 = group.iloc[0], group.iloc[1]
            # Convert to strings with zero-padding to match crash_map format
            crash_pk = tuple(str(r0[col]).zfill(2) if col != 'Department Case Number' else str(r0[col])
                           for col in crash_key_cols)

            if crash_pk in crash_map:
                crash_versions = crash_map[crash_pk]

                if len(crash_versions) == 2:
                    (c0_lineno, c0_case), (c1_lineno, c1_case) = crash_versions

                    # Check if one UCASE, one TCASE
                    if {c0_case, c1_case} == {'ucase', 'tcase'}:
                        # Determine which V/O came from which crash using line ordering
                        v0_lineno, v1_lineno = r0['lineno'], r1['lineno']

                        # V/O from first crash (lower lineno) → use c0_case
                        # V/O from second crash (higher lineno) → use c1_case
                        if v0_lineno < v1_lineno:
                            # r0 from c0, r1 from c1
                            if c1_case == 'tcase':
                                # Keep r1 (from TCASE)
                                merged = r1.drop('lineno')
                                tcase_kept += 1
                            else:
                                # Keep r0 (from TCASE)
                                merged = r0.drop('lineno')
                                tcase_kept += 1
                        else:
                            # r1 from c0, r0 from c1 (unusual ordering)
                            if c0_case == 'tcase':
                                # Keep r1 (from TCASE)
                                merged = r1.drop('lineno')
                                tcase_kept += 1
                            else:
                                # Keep r0 (from TCASE)
                                merged = r0.drop('lineno')
                                tcase_kept += 1

                        merged_records.append(merged)
                        continue

            # Fallback: keep first
            merged = group.iloc[0].drop('lineno')
            merged_records.append(merged)
            fallback_kept += 1
        else:
            # 3+ duplicates: keep first
            merged = group.iloc[0].drop('lineno')
            merged_records.append(merged)
            fallback_kept += 1

    merged_df = pd.DataFrame(merged_records)

    # Preserve original dtypes
    for col in merged_df.columns:
        if col in df.columns:
            try:
                merged_df[col] = merged_df[col].astype(df[col].dtype)
            except (ValueError, TypeError):
                pass

    # Combine with non-duplicates
    result = pd.concat([non_dupes, merged_df], ignore_index=False).sort_index()
    result.index.name = df.index.name

    # Drop temporary columns
    result = result.drop(columns=['_orig_lineno'], errors='ignore')

    err(f"  TCASE-based merges: {tcase_kept:,} ({100*tcase_kept/num_groups:.1f}%)")
    err(f"  Fallback (kept first): {fallback_kept:,} ({100*fallback_kept/num_groups:.1f}%)")

    return result
