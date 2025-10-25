#!/usr/bin/env -S uv run --quiet --script
# /// script
# dependencies = [
#   "pandas",
#   "pyarrow",
# ]
# ///
"""
Analyze 2023 duplicate patterns across Crashes, Vehicles, and Occupants.

Questions:
1. How many full dupes vs PK dupes in V and O?
2. Are dupe crashes overrepresented in V/O dupes?
3. Are dupe vehicles overrepresented in O dupes?
"""
import pandas as pd
import sys
from functools import partial
from pathlib import Path
from typing import Optional

err = partial(print, file=sys.stderr)


def load_raw_2023(entity_type: str) -> pd.DataFrame:
    """Load raw 2023 parquet before deduplication."""
    path = f'njdot/data/2023/NewJersey2023{entity_type}.pqt'
    return pd.read_parquet(path)


def analyze_duplicates(
    df: pd.DataFrame,
    pk_cols: list[str],
    entity_name: str,
) -> dict:
    """
    Analyze duplicate patterns in a dataset.

    Returns dict with:
    - total: total records
    - unique_pks: number of unique primary keys
    - full_dupes: number of full duplicate records
    - pk_dupes: number of records with duplicate PKs but different data
    - dupe_groups: number of duplicate PK groups
    - max_group_size: largest duplicate group size
    """
    total = len(df)
    unique_pks = df[pk_cols].drop_duplicates().shape[0]

    # Full duplicates (all columns identical)
    full_dupe_mask = df.duplicated(keep=False)
    full_dupes = full_dupe_mask.sum()

    # PK duplicates (same PK, different data)
    pk_dupe_mask = df.duplicated(pk_cols, keep=False)
    pk_dupes = pk_dupe_mask.sum()

    # Duplicate groups
    dupe_groups = df[pk_dupe_mask].groupby(pk_cols).size()
    num_dupe_groups = len(dupe_groups)
    max_group_size = dupe_groups.max() if num_dupe_groups > 0 else 0

    # Records with duplicate PKs but not full duplicates
    pk_only_dupes = pk_dupes - full_dupes

    stats = {
        'entity': entity_name,
        'total': total,
        'unique_pks': unique_pks,
        'full_dupes': full_dupes,
        'pk_only_dupes': pk_only_dupes,
        'pk_dupes_total': pk_dupes,
        'dupe_groups': num_dupe_groups,
        'max_group_size': max_group_size,
    }

    err(f"\n{entity_name}:")
    err(f"  Total records: {total:,}")
    err(f"  Unique PKs: {unique_pks:,}")
    err(f"  Full duplicates: {full_dupes:,} ({100*full_dupes/total:.2f}%)")
    err(f"  PK-only duplicates: {pk_only_dupes:,} ({100*pk_only_dupes/total:.2f}%)")
    err(f"  Total PK duplicates: {pk_dupes:,} ({100*pk_dupes/total:.2f}%)")
    err(f"  Duplicate groups: {num_dupe_groups:,}")
    if num_dupe_groups > 0:
        err(f"  Max group size: {max_group_size}")

    return stats


def get_dupe_crash_keys(df: pd.DataFrame, pk_cols: list[str]) -> set:
    """Get set of crash keys (cc, mc, case) that have duplicates."""
    crash_key_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    dupe_mask = df.duplicated(pk_cols, keep=False)
    dupe_crash_keys = df[dupe_mask][crash_key_cols].drop_duplicates()
    return set(tuple(row) for row in dupe_crash_keys.values)


def get_dupe_vehicle_keys(df: pd.DataFrame, pk_cols: list[str]) -> set:
    """Get set of vehicle keys (cc, mc, case, vn) that have duplicates."""
    vehicle_key_cols = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number']
    dupe_mask = df.duplicated(pk_cols, keep=False)
    dupe_vehicle_keys = df[dupe_mask][vehicle_key_cols].drop_duplicates()
    return set(tuple(row) for row in dupe_vehicle_keys.values)


def main():
    err("Loading 2023 raw data...")

    # Load raw data
    crashes = load_raw_2023('Accidents')
    vehicles = load_raw_2023('Vehicles')
    occupants = load_raw_2023('Occupants')
    pedestrians = load_raw_2023('Pedestrians')

    err("\n" + "="*60)
    err("QUESTION 1: Full dupes vs PK dupes in V and O")
    err("="*60)

    # Analyze each entity
    crash_pk = ['County Code', 'Municipality Code', 'Department Case Number']
    vehicle_pk = crash_pk + ['Vehicle Number']
    occupant_pk = vehicle_pk + ['Occupant Number']
    pedestrian_pk = crash_pk + ['Pedestrian Number']

    c_stats = analyze_duplicates(crashes, crash_pk, 'Crashes')
    v_stats = analyze_duplicates(vehicles, vehicle_pk, 'Vehicles')
    o_stats = analyze_duplicates(occupants, occupant_pk, 'Occupants')
    p_stats = analyze_duplicates(pedestrians, pedestrian_pk, 'Pedestrians')

    err("\n" + "="*60)
    err("QUESTION 2: Are dupe crashes overrep'd in V/O dupes?")
    err("="*60)

    # Get crash keys with duplicates
    dupe_crash_keys = get_dupe_crash_keys(crashes, crash_pk)
    err(f"\nCrashes with duplicates: {len(dupe_crash_keys):,}")

    # Check how many V/O dupes are in dupe crashes
    v_dupe_mask = vehicles.duplicated(vehicle_pk, keep=False)
    v_dupes = vehicles[v_dupe_mask]
    v_crash_keys = set(tuple(row) for row in v_dupes[crash_pk].values)
    v_in_dupe_crashes = len(v_crash_keys & dupe_crash_keys)

    o_dupe_mask = occupants.duplicated(occupant_pk, keep=False)
    o_dupes = occupants[o_dupe_mask]
    o_crash_keys = set(tuple(row) for row in o_dupes[crash_pk].values)
    o_in_dupe_crashes = len(o_crash_keys & dupe_crash_keys)

    err(f"\nVehicle duplicates:")
    err(f"  Total crashes with vehicle dupes: {len(v_crash_keys):,}")
    err(f"  In crashes with crash dupes: {v_in_dupe_crashes:,} ({100*v_in_dupe_crashes/len(v_crash_keys):.2f}%)")
    err(f"  Expected (baseline): {len(dupe_crash_keys)} / {c_stats['unique_pks']} = {100*len(dupe_crash_keys)/c_stats['unique_pks']:.2f}%")

    err(f"\nOccupant duplicates:")
    err(f"  Total crashes with occupant dupes: {len(o_crash_keys):,}")
    err(f"  In crashes with crash dupes: {o_in_dupe_crashes:,} ({100*o_in_dupe_crashes/len(o_crash_keys):.2f}%)")
    err(f"  Expected (baseline): {len(dupe_crash_keys)} / {c_stats['unique_pks']} = {100*len(dupe_crash_keys)/c_stats['unique_pks']:.2f}%")

    err("\n" + "="*60)
    err("QUESTION 3: Are dupe vehicles overrep'd in O dupes?")
    err("="*60)

    # Get vehicle keys with duplicates
    dupe_vehicle_keys = get_dupe_vehicle_keys(vehicles, vehicle_pk)
    err(f"\nVehicles with duplicates: {len(dupe_vehicle_keys):,}")

    # Check how many O dupes are in dupe vehicles
    o_vehicle_keys = set(tuple(row) for row in o_dupes[vehicle_pk].values)
    o_in_dupe_vehicles = len(o_vehicle_keys & dupe_vehicle_keys)

    err(f"\nOccupant duplicates:")
    err(f"  Total vehicles with occupant dupes: {len(o_vehicle_keys):,}")
    err(f"  In vehicles with vehicle dupes: {o_in_dupe_vehicles:,} ({100*o_in_dupe_vehicles/len(o_vehicle_keys):.2f}%)")
    err(f"  Expected (baseline): {len(dupe_vehicle_keys)} / {v_stats['unique_pks']} = {100*len(dupe_vehicle_keys)/v_stats['unique_pks']:.2f}%")

    # Summary stats
    err("\n" + "="*60)
    err("SUMMARY")
    err("="*60)
    err(f"\nDuplicate correlation analysis:")

    # Calculate enrichment factors
    crash_baseline = len(dupe_crash_keys) / c_stats['unique_pks']
    v_in_dupe_crashes_rate = v_in_dupe_crashes / len(v_crash_keys)
    o_in_dupe_crashes_rate = o_in_dupe_crashes / len(o_crash_keys)

    vehicle_baseline = len(dupe_vehicle_keys) / v_stats['unique_pks']
    o_in_dupe_vehicles_rate = o_in_dupe_vehicles / len(o_vehicle_keys)

    err(f"\nV dupes in C dupes: {v_in_dupe_crashes_rate:.2%} vs {crash_baseline:.2%} baseline = {v_in_dupe_crashes_rate/crash_baseline:.1f}x enrichment")
    err(f"O dupes in C dupes: {o_in_dupe_crashes_rate:.2%} vs {crash_baseline:.2%} baseline = {o_in_dupe_crashes_rate/crash_baseline:.1f}x enrichment")
    err(f"O dupes in V dupes: {o_in_dupe_vehicles_rate:.2%} vs {vehicle_baseline:.2%} baseline = {o_in_dupe_vehicles_rate/vehicle_baseline:.1f}x enrichment")


if __name__ == '__main__':
    main()
