#!/usr/bin/env -S uv run --quiet --script
# /// script
# dependencies = [
#   "pandas",
#   "pyarrow",
# ]
# ///
"""
Trace vehicle/occupant duplicates back to their source crash version.

Key insight: V/O duplicates exist because crashes have duplicates. Each crash
version (UCASE/TCASE) has its own V/O records. Can we identify which V/O
records came from which crash version and preferentially keep those from TCASE?
"""
import pandas as pd
import sys
from functools import partial

err = partial(print, file=sys.stderr)


def trace_to_crash_version():
    """
    Match V/O duplicate records back to their source crash record using line numbers.
    """
    err("Loading raw 2023 data...")

    # Load raw data (before any processing)
    crashes_raw = pd.read_parquet('njdot/data/2023/NewJersey2023Accidents.pqt')
    vehicles_raw = pd.read_parquet('njdot/data/2023/NewJersey2023Vehicles.pqt')
    occupants_raw = pd.read_parquet('njdot/data/2023/NewJersey2023Occupants.pqt')

    # Load crash duplicates with metadata
    crash_dupes = pd.read_parquet('njdot/data/2023/crash_dupes/merged.pqt')

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

    # Create line number -> crash case mapping
    crash_lineno_to_case = dict(zip(crash_dupes['lineno'], crash_dupes['case_class']))

    # Create crash PK -> set of line numbers mapping
    crash_key_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    crash_pk_to_linenos = {}
    for _, row in crash_dupes.iterrows():
        pk = tuple(row[crash_key_cols])
        if pk not in crash_pk_to_linenos:
            crash_pk_to_linenos[pk] = []
        crash_pk_to_linenos[pk].append(row['lineno'])

    err(f"Loaded {len(crash_dupes)} crash duplicate records")
    err(f"  UCASE: {(crash_dupes['case_class'] == 'ucase').sum()}")
    err(f"  TCASE: {(crash_dupes['case_class'] == 'tcase').sum()}")
    err(f"  Neither: {(crash_dupes['case_class'] == 'neither').sum()}")

    # Now analyze vehicles
    err("\n" + "="*60)
    err("Analyzing Vehicle Duplicates")
    err("="*60)

    vehicle_pk = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number']
    vehicle_dupes = vehicles_raw[vehicles_raw.duplicated(vehicle_pk, keep=False)].copy()
    vehicle_dupes['lineno'] = vehicle_dupes.index + 2  # 1-based + header

    err(f"Total vehicle duplicates: {len(vehicle_dupes)}")

    # For vehicle pairs in crash dupes, check if line number ordering correlates with crash ordering
    grouped = vehicle_dupes.groupby(vehicle_pk, sort=False)
    pairs = [group for pk, group in grouped if len(group) == 2]

    in_crash_dupes = 0
    both_crash_linenos_known = 0
    line_order_matches_crash = 0
    can_identify_tcase_vehicle = 0

    for group in pairs:
        r0, r1 = group.iloc[0], group.iloc[1]
        crash_pk = tuple(r0[crash_key_cols])

        if crash_pk not in crash_pk_to_linenos:
            continue

        in_crash_dupes += 1
        crash_linenos = sorted(crash_pk_to_linenos[crash_pk])

        if len(crash_linenos) != 2:
            continue

        # Check if we can determine which crash each vehicle came from
        # Hypothesis: vehicles are stored in same order as crashes in the file
        # So vehicle at lower line number comes from crash at lower line number

        v0_lineno = r0['lineno']
        v1_lineno = r1['lineno']
        c0_lineno, c1_lineno = crash_linenos

        both_crash_linenos_known += 1

        # Check if vehicle line order matches crash line order
        # We expect vehicles from first crash to appear before vehicles from second crash
        if v0_lineno < v1_lineno and c0_lineno < c1_lineno:
            line_order_matches_crash += 1

            # Check if we can identify TCASE vehicle
            c0_case = crash_lineno_to_case.get(c0_lineno)
            c1_case = crash_lineno_to_case.get(c1_lineno)

            if c0_case in ['ucase', 'tcase'] and c1_case in ['ucase', 'tcase']:
                if c0_case != c1_case:  # One UCASE, one TCASE
                    can_identify_tcase_vehicle += 1

    err(f"\nVehicle pairs analysis:")
    err(f"  Total pairs: {len(pairs)}")
    err(f"  In crash dupes: {in_crash_dupes} ({100*in_crash_dupes/len(pairs):.1f}%)")
    err(f"  Both crash linenos known: {both_crash_linenos_known}")
    err(f"  Line order matches crash: {line_order_matches_crash} ({100*line_order_matches_crash/both_crash_linenos_known:.1f}%)")
    err(f"  Can identify TCASE vehicle: {can_identify_tcase_vehicle} ({100*can_identify_tcase_vehicle/both_crash_linenos_known:.1f}%)")

    # Now analyze occupants
    err("\n" + "="*60)
    err("Analyzing Occupant Duplicates")
    err("="*60)

    occupant_pk = vehicle_pk + ['Occupant Number']
    occupant_dupes = occupants_raw[occupants_raw.duplicated(occupant_pk, keep=False)].copy()
    occupant_dupes['lineno'] = occupant_dupes.index + 2

    err(f"Total occupant duplicates: {len(occupant_dupes)}")

    grouped = occupant_dupes.groupby(occupant_pk, sort=False)
    pairs = [group for pk, group in grouped if len(group) == 2]

    in_crash_dupes = 0
    both_crash_linenos_known = 0
    line_order_matches_crash = 0
    can_identify_tcase_occupant = 0

    for group in pairs:
        r0, r1 = group.iloc[0], group.iloc[1]
        crash_pk = tuple(r0[crash_key_cols])

        if crash_pk not in crash_pk_to_linenos:
            continue

        in_crash_dupes += 1
        crash_linenos = sorted(crash_pk_to_linenos[crash_pk])

        if len(crash_linenos) != 2:
            continue

        o0_lineno = r0['lineno']
        o1_lineno = r1['lineno']
        c0_lineno, c1_lineno = crash_linenos

        both_crash_linenos_known += 1

        if o0_lineno < o1_lineno and c0_lineno < c1_lineno:
            line_order_matches_crash += 1

            c0_case = crash_lineno_to_case.get(c0_lineno)
            c1_case = crash_lineno_to_case.get(c1_lineno)

            if c0_case in ['ucase', 'tcase'] and c1_case in ['ucase', 'tcase']:
                if c0_case != c1_case:
                    can_identify_tcase_occupant += 1

    err(f"\nOccupant pairs analysis:")
    err(f"  Total pairs: {len(pairs)}")
    err(f"  In crash dupes: {in_crash_dupes} ({100*in_crash_dupes/len(pairs):.1f}%)")
    err(f"  Both crash linenos known: {both_crash_linenos_known}")
    err(f"  Line order matches crash: {line_order_matches_crash} ({100*line_order_matches_crash/both_crash_linenos_known:.1f}%)")
    err(f"  Can identify TCASE occupant: {can_identify_tcase_occupant} ({100*can_identify_tcase_occupant/both_crash_linenos_known:.1f}%)")


if __name__ == '__main__':
    trace_to_crash_version()
