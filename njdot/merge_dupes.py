"""
Duplicate crash record merging logic.

Implements smart merge strategies for duplicate crash records, particularly
the ucase/tcase pattern discovered in 2023 NJDOT data where:
- UPPERCASE records = original/ungeocoded versions
- Title/mixed case = updated/geocoded versions
"""
import pandas as pd
import re
from geopy.distance import distance as geodist
from typing import Optional
from utz import err


def classify_case(row: pd.Series, text_fields: list[str]) -> str:
    """
    Classify a record as ucase, tcase, or neither based on text field casing.

    Args:
        row: Crash record
        text_fields: List of text field names to examine

    Returns:
        'ucase' if majority of text is UPPERCASE (original/ungeocoded version)
        'tcase' if majority has mixed case (updated/geocoded version)
        'neither' if no clear pattern
    """
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

    # If majority (>50%) are uppercase
    if upper_count / total_fields > 0.5:
        return 'ucase'
    # If majority have mixed case
    elif mixed_count / total_fields > 0.5:
        return 'tcase'
    else:
        return 'neither'


def merge_ucase_tcase(
    ucase: pd.Series,
    tcase: pd.Series,
    fillable_fields: Optional[list[str]] = None,
) -> pd.Series:
    """
    Merge ucase (original) and tcase (updated/geocoded) records.

    Strategy:
    - Use TCASE as base (it has geocoding and updates)
    - Fill missing TCASE fields from UCASE when legitimate
    - Always prefer TCASE lat/lon (UCASE geocoding is unreliable)

    Args:
        ucase: Original/ungeocoded record (UPPERCASE text)
        tcase: Updated/geocoded record (Title/mixed case text)
        fillable_fields: Fields to fill from UCASE when missing in TCASE

    Returns:
        Merged record (based on TCASE)
    """
    # Start with TCASE as base
    merged = tcase.copy()

    # Default fillable fields (using original column names)
    if fillable_fields is None:
        fillable_fields = [
            'SRI (Standard Route Identifier)',
            'Mile Post',
            'Cross Street Name',
            'Direction From Cross Street',
        ]

    # Fill missing TCASE fields from UCASE (when TCASE doesn't have it)
    for field in fillable_fields:
        # Skip if field doesn't exist in the data
        if field not in tcase.index or field not in ucase.index:
            continue

        t_val = tcase[field]
        u_val = ucase[field]

        t_empty = pd.isna(t_val) or (isinstance(t_val, str) and t_val.strip() == '')
        u_has = pd.notna(u_val) and (not isinstance(u_val, str) or u_val.strip() != '')

        if t_empty and u_has:
            merged[field] = u_val

    return merged


def merge_duplicates(
    df: pd.DataFrame,
    pk_cols: list[str],
    text_fields: Optional[list[str]] = None,
    fillable_fields: Optional[list[str]] = None,
) -> pd.DataFrame:
    """
    Merge duplicate crash records in a DataFrame.

    Uses ucase/tcase merge strategy when applicable (69.5% success rate on 2023 data).
    For duplicates that don't fit the ucase/tcase pattern, keeps the last record.

    Args:
        df: DataFrame with potential duplicates
        pk_cols: Primary key columns that define duplicates
        text_fields: Text fields to examine for case classification
                    (defaults to common crash record text fields)
        fillable_fields: Fields to fill from UCASE when missing in TCASE
                        (defaults to SRI, MP, Cross Street, Direction)

    Returns:
        DataFrame with duplicates merged
    """
    if text_fields is None:
        text_fields = ['Police Department', 'Crash Location', 'Cross Street Name']

    # Find duplicates
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        return df  # No duplicates

    num_dupes = dupe_mask.sum()
    dupes = df[dupe_mask].copy()
    non_dupes = df[~dupe_mask].copy()

    # Classify case for each duplicate record
    dupes['_case_class'] = dupes.apply(lambda r: classify_case(r, text_fields), axis=1)

    # Group by PK
    grouped = dupes.groupby(pk_cols, sort=False)
    num_groups = len(grouped)

    merged_records = []
    ucase_tcase_merges = 0

    for pk, group in grouped:
        if len(group) == 2:
            # Check if this is a ucase/tcase pair
            r1, r2 = group.iloc[0], group.iloc[1]
            cases = sorted([r1['_case_class'], r2['_case_class']])
            is_ucase_tcase = (cases == ['tcase', 'ucase'])

            if is_ucase_tcase:
                # Identify which is which
                if r1['_case_class'] == 'ucase':
                    ucase, tcase = r1, r2
                else:
                    ucase, tcase = r2, r1

                # Use ucase/tcase merge strategy
                merged = merge_ucase_tcase(ucase, tcase, fillable_fields=fillable_fields)
                ucase_tcase_merges += 1
            else:
                # Keep last record (like original behavior)
                merged = group.iloc[-1]
        else:
            # 3+ duplicates - keep last record
            merged = group.iloc[-1]

        # Drop temporary classification column
        merged_records.append(merged.drop('_case_class'))

    merged_df = pd.DataFrame(merged_records)

    # Preserve original dtypes (important for Int8/Int16/timestamp precision)
    # This prevents type upcasting that increases storage size
    for col in merged_df.columns:
        if col in df.columns and col != '_case_class':
            try:
                merged_df[col] = merged_df[col].astype(df[col].dtype)
            except (ValueError, TypeError):
                # If conversion fails, keep the merged dtype
                pass

    # Combine non-duplicates with merged duplicates
    result = pd.concat([non_dupes, merged_df], ignore_index=False).sort_index()

    # Preserve original index name
    result.index.name = df.index.name

    err(f"Merged {num_dupes} duplicate records ({num_groups} groups)")
    if ucase_tcase_merges > 0:
        pct = 100 * ucase_tcase_merges / num_groups
        err(f"  UCASE/TCASE merges: {ucase_tcase_merges} ({pct:.1f}%)")
        err(f"  Fallback (kept last): {num_groups - ucase_tcase_merges}")

    return result
