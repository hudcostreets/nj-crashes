#!/usr/bin/env -S uv run --quiet --script
# /// script
# dependencies = [
#   "pandas",
#   "pyarrow",
# ]
# ///
"""
Analyze vehicle and occupant duplicate patterns to detect "versions".

Since V/O duplicates are highly correlated with crash duplicates (which show
UCASE/TCASE versioning pattern), analyze whether V/O duplicates also show
systematic version patterns that would allow intelligent merging.
"""
import pandas as pd
import sys
from functools import partial

err = partial(print, file=sys.stderr)


def analyze_completeness(df: pd.DataFrame, pk_cols: list[str], entity_name: str):
    """
    Analyze data completeness patterns in duplicate groups.

    Returns stats on which duplicate position (0 vs 1) has more complete data.
    """
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        return None

    dupes = df[dupe_mask].copy()
    grouped = dupes.groupby(pk_cols, sort=False)

    # Only analyze pairs (ignore 3+ groups for now)
    pairs = [group for pk, group in grouped if len(group) == 2]
    if not pairs:
        return None

    err(f"\n{entity_name} Completeness Analysis ({len(pairs)} pairs):")
    err("="*60)

    # For each pair, count non-null fields in each record
    completeness_winner = []  # 0 if first is more complete, 1 if second, None if tie

    for group in pairs:
        r0, r1 = group.iloc[0], group.iloc[1]

        # Count non-null values (excluding metadata and PK columns)
        exclude_cols = set(pk_cols) | {'lineno', 'group_idx', 'idx'}
        data_cols = [c for c in group.columns if c not in exclude_cols]

        count0 = r0[data_cols].notna().sum()
        count1 = r1[data_cols].notna().sum()

        if count0 > count1:
            completeness_winner.append(0)
        elif count1 > count0:
            completeness_winner.append(1)
        else:
            completeness_winner.append(None)

    # Statistics
    pos0_wins = sum(1 for w in completeness_winner if w == 0)
    pos1_wins = sum(1 for w in completeness_winner if w == 1)
    ties = sum(1 for w in completeness_winner if w is None)

    err(f"  Position 0 more complete: {pos0_wins} ({100*pos0_wins/len(pairs):.1f}%)")
    err(f"  Position 1 more complete: {pos1_wins} ({100*pos1_wins/len(pairs):.1f}%)")
    err(f"  Ties: {ties} ({100*ties/len(pairs):.1f}%)")

    return {
        'pos0_wins': pos0_wins,
        'pos1_wins': pos1_wins,
        'ties': ties,
        'total_pairs': len(pairs),
    }


def analyze_field_differences(df: pd.DataFrame, pk_cols: list[str], entity_name: str, interesting_fields: list[str]):
    """
    Analyze which fields differ between duplicate pairs and look for patterns.
    """
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if not dupe_mask.any():
        return None

    dupes = df[dupe_mask].copy()
    grouped = dupes.groupby(pk_cols, sort=False)

    # Only analyze pairs
    pairs = [group for pk, group in grouped if len(group) == 2]
    if not pairs:
        return None

    err(f"\n{entity_name} Field Difference Analysis:")
    err("="*60)

    # Track which fields differ and their patterns
    field_diff_counts = {}
    field_patterns = {}  # field -> {(val0, val1): count}

    for field in interesting_fields:
        if field not in df.columns:
            continue

        field_diff_counts[field] = 0
        field_patterns[field] = {}

        for group in pairs:
            r0, r1 = group.iloc[0], group.iloc[1]
            v0, v1 = r0[field], r1[field]

            # Check if different (handling NaN)
            if pd.isna(v0) and pd.isna(v1):
                continue
            if pd.isna(v0) or pd.isna(v1) or v0 != v1:
                field_diff_counts[field] += 1

                # Track pattern
                pattern = (str(v0) if pd.notna(v0) else 'NULL',
                          str(v1) if pd.notna(v1) else 'NULL')
                field_patterns[field][pattern] = field_patterns[field].get(pattern, 0) + 1

    # Report fields sorted by difference frequency
    sorted_fields = sorted(field_diff_counts.items(), key=lambda x: x[1], reverse=True)

    err(f"\nFields differing between pairs (top 15):")
    for field, count in sorted_fields[:15]:
        pct = 100 * count / len(pairs)
        err(f"  {field:30s}: {count:4d} pairs ({pct:5.1f}%)")

        # Show top patterns for high-frequency fields
        if count > len(pairs) * 0.1:  # More than 10% of pairs differ
            patterns = field_patterns[field]
            top_patterns = sorted(patterns.items(), key=lambda x: x[1], reverse=True)[:3]
            for (v0, v1), pcount in top_patterns:
                v0_short = v0[:30] if len(v0) <= 30 else v0[:27] + "..."
                v1_short = v1[:30] if len(v1) <= 30 else v1[:27] + "..."
                err(f"    {v0_short} → {v1_short}: {pcount}")

    return field_diff_counts


def analyze_crash_dupe_correlation(
    entity_df: pd.DataFrame,
    entity_pk: list[str],
    entity_name: str,
):
    """
    For entity duplicates that occur in crash duplicates, check if they align
    with crash version patterns (UCASE vs TCASE).
    """
    # Load crash duplicates
    crash_dupes = pd.read_parquet('njdot/data/2023/crash_dupes/merged.pqt')

    # Classify crashes as ucase/tcase
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

    # Get crash key mapping to case_class
    crash_key_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    crash_case_map = crash_dupes.set_index(crash_key_cols)['case_class'].to_dict()

    # Filter entity duplicates to those in crash duplicates
    entity_dupes = entity_df[entity_df.duplicated(entity_pk, keep=False)].copy()

    # Add crash case classification
    entity_dupes['crash_case'] = entity_dupes.apply(
        lambda r: crash_case_map.get((r['County Code'], r['Municipality Code'], r['Department Case Number']), 'not_dupe'),
        axis=1
    )

    # Count by crash case type
    in_ucase = (entity_dupes['crash_case'] == 'ucase').sum()
    in_tcase = (entity_dupes['crash_case'] == 'tcase').sum()
    in_neither = (entity_dupes['crash_case'] == 'neither').sum()
    in_crash_dupes = in_ucase + in_tcase + in_neither
    not_in_crash_dupes = (entity_dupes['crash_case'] == 'not_dupe').sum()

    err(f"\n{entity_name} Duplicates by Crash Case Type:")
    err("="*60)
    err(f"  In UCASE crashes: {in_ucase:,}")
    err(f"  In TCASE crashes: {in_tcase:,}")
    err(f"  In neither crashes: {in_neither:,}")
    err(f"  Total in crash dupes: {in_crash_dupes:,}")
    err(f"  Not in crash dupes: {not_in_crash_dupes:,}")

    # For pairs in UCASE/TCASE crash pairs, analyze if data completeness correlates
    grouped = entity_dupes[entity_dupes['crash_case'].isin(['ucase', 'tcase'])].groupby(entity_pk, sort=False)
    pairs = [group for pk, group in grouped if len(group) == 2]

    if pairs:
        err(f"\nAnalyzing {len(pairs)} {entity_name} pairs in UCASE/TCASE crashes:")

        # Check if position correlates with crash case
        ucase_in_pos = {0: 0, 1: 0}
        tcase_in_pos = {0: 0, 1: 0}

        for group in pairs:
            for idx, (_, row) in enumerate(group.iterrows()):
                if row['crash_case'] == 'ucase':
                    ucase_in_pos[idx] += 1
                elif row['crash_case'] == 'tcase':
                    tcase_in_pos[idx] += 1

        err(f"  UCASE in position 0: {ucase_in_pos[0]}, position 1: {ucase_in_pos[1]}")
        err(f"  TCASE in position 0: {tcase_in_pos[0]}, position 1: {tcase_in_pos[1]}")

        # Check data completeness by crash case
        exclude_cols = set(entity_pk) | {'lineno', 'group_idx', 'idx', 'crash_case'}
        data_cols = [c for c in entity_dupes.columns if c not in exclude_cols]

        ucase_completeness = []
        tcase_completeness = []

        for group in pairs:
            for _, row in group.iterrows():
                completeness = row[data_cols].notna().sum()
                if row['crash_case'] == 'ucase':
                    ucase_completeness.append(completeness)
                elif row['crash_case'] == 'tcase':
                    tcase_completeness.append(completeness)

        if ucase_completeness and tcase_completeness:
            ucase_avg = sum(ucase_completeness) / len(ucase_completeness)
            tcase_avg = sum(tcase_completeness) / len(tcase_completeness)
            err(f"  Avg completeness: UCASE={ucase_avg:.1f}, TCASE={tcase_avg:.1f}")
            if tcase_avg > ucase_avg:
                err(f"  → TCASE records are {tcase_avg - ucase_avg:.1f} fields more complete on average")
            elif ucase_avg > tcase_avg:
                err(f"  → UCASE records are {ucase_avg - tcase_avg:.1f} fields more complete on average")


def main():
    err("Loading 2023 duplicate data with metadata...")

    # Load duplicate records (with metadata added by write_dupe_outputs.py)
    vehicles = pd.read_parquet('njdot/data/2023/vehicles_dupes/merged.pqt')
    occupants = pd.read_parquet('njdot/data/2023/occupants_dupes/merged.pqt')

    vehicle_pk = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number']
    occupant_pk = vehicle_pk + ['Occupant Number']

    # Analyze completeness patterns
    v_comp = analyze_completeness(vehicles, vehicle_pk, 'Vehicles')
    o_comp = analyze_completeness(occupants, occupant_pk, 'Occupants')

    # Analyze field differences
    vehicle_fields = [
        'Color of Vehicle', 'Make of Vehicle', 'Model of Vehicle',
        'Year of Vehicle', 'Owner State', 'License Plate State',
        'Vehicle Type', 'Vehicle Use',
        'Contributing Circumstances 1', 'Contributing Circumstances 2',
        'Direction of Travel', 'Pre-Crash Action',
        'First Sequence of Events', 'Second Sequence of Events',
        'Third Sequence of Events', 'Fourth Sequence of Events',
        'Hit & Run Driver Flag', 'Extent of Damage', 'Most Harmful Event',
        'Initial Impact Location', 'Principal Damage Location',
        'Driven/Left at Scene/Towed', 'Cargo Body Type', 'Insurance Company Code',
    ]

    occupant_fields = [
        'Physical Condition', 'Position In/On Vehicle', 'Ejection Code',
        'Age', 'Sex',
        'Location of Most Severe Injury', 'Type of Most Severe Physical Injury',
        'Refused Medical Attention',
        'Safety Equipment Available', 'Safety Equipment Used', 'Airbag Deployment',
        'Hospital Code',
    ]

    analyze_field_differences(vehicles, vehicle_pk, 'Vehicles', vehicle_fields)
    analyze_field_differences(occupants, occupant_pk, 'Occupants', occupant_fields)

    # Analyze correlation with crash UCASE/TCASE pattern
    analyze_crash_dupe_correlation(vehicles, vehicle_pk, 'Vehicles')
    analyze_crash_dupe_correlation(occupants, occupant_pk, 'Occupants')


if __name__ == '__main__':
    main()
