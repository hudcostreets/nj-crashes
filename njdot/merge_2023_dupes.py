#!/usr/bin/env python3
"""
Merge 2023 duplicate crash records with detailed analysis and metadata.

This script provides detailed duplicate analysis beyond the core merge logic,
including metadata tracking, distance calculations, and multiple output files
for inspection.

Uses canonical merge logic from njdot.merge_dupes module.
"""
import pandas as pd
import re
from geopy.distance import distance as geodist
from typing import Optional

# Import canonical merge logic
from njdot.merge_dupes import classify_case, merge_ucase_tcase

def normalize_pd_name(name: str) -> str:
    """Normalize Police Department names for comparison."""
    if pd.isna(name) or name == '':
        return ''

    name = str(name).strip()

    # Common suffixes to normalize
    name = re.sub(r'\s+POLICE\s+DEPART?MENT?$', ' PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+POLICE$', ' PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+BORO(?:\s+PD)?$', ' PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+BOROUGH(?:\s+PD)?$', ' PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+TOWN(?:\s+PD)?$', ' PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+TWP(?:SP)?(?:\s+PD)?$', ' TWP PD', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+TOWNSHIP(?:\s+PD)?$', ' TWP PD', name, flags=re.IGNORECASE)

    # Normalize case
    name = name.upper()

    # Clean up whitespace
    name = re.sub(r'\s+', ' ', name).strip()

    return name

def normalize_street_name(name: str) -> str:
    """Normalize street/location names for comparison."""
    if pd.isna(name) or name == '':
        return ''

    name = str(name).strip()

    # Normalize common suffixes
    suffixes = [
        (r'\bAVENUE$', 'AVE'),
        (r'\bSTREET$', 'ST'),
        (r'\bROAD$', 'RD'),
        (r'\bBOULEVARD$', 'BLVD'),
        (r'\bDRIVE$', 'DR'),
        (r'\bLANE$', 'LN'),
        (r'\bCOURT$', 'CT'),
        (r'\bPLACE$', 'PL'),
        (r'\bTERRACE$', 'TER'),
        (r'\bPARKWAY$', 'PKWY'),
    ]

    name_upper = name.upper()
    for pattern, replacement in suffixes:
        name_upper = re.sub(pattern, replacement, name_upper)

    return name_upper

def ll_distance_feet(lat1: float, lon1: float, lat2: float, lon2: float) -> Optional[float]:
    """Calculate distance between two lat/lon points in feet."""
    if pd.isna(lat1) or pd.isna(lon1) or pd.isna(lat2) or pd.isna(lon2):
        return None
    try:
        d = geodist((lat1, lon1), (lat2, lon2))
        return d.feet
    except:
        return None

def gmaps_url(lat1: float, lon1: float, lat2: float, lon2: float) -> Optional[str]:
    """Generate Google Maps URL showing directions between two lat/lon points."""
    if pd.isna(lat1) or pd.isna(lon1) or pd.isna(lat2) or pd.isna(lon2):
        return None
    try:
        # Center point between the two locations
        center_lat = (lat1 + lat2) / 2
        center_lon = (lon1 + lon2) / 2
        # Format: /dir/'lat1,lon1'/lat2,lon2/@center_lat,center_lon,19z/
        return f"https://www.google.com/maps/dir/'{lat1},{lon1}'/{lat2},{lon2}/@{center_lat},{center_lon},19z/"
    except:
        return None

def merge_ucase_tcase_with_metadata(ucase: pd.Series, tcase: pd.Series) -> tuple[pd.Series, Optional[float], Optional[str]]:
    """
    Wrapper around canonical merge_ucase_tcase that adds metadata (ll_dist, gmaps).

    Returns:
        merged: Merged record (based on TCASE)
        ll_dist: Distance in feet between lat/lons (if both present)
        gmaps: Google Maps URL (if both have lat/lon)
    """
    # Use canonical merge logic
    merged = merge_ucase_tcase(ucase, tcase)

    ll_dist = None
    gmaps = None

    # Calculate distance metadata
    u_lat, u_lon = ucase['Latitude'], ucase['Longitude']
    t_lat, t_lon = tcase['Latitude'], tcase['Longitude']

    if pd.notna(u_lat) and pd.notna(u_lon) and pd.notna(t_lat) and pd.notna(t_lon):
        if (u_lat, u_lon) != (t_lat, t_lon):
            ll_dist = ll_distance_feet(u_lat, u_lon, t_lat, t_lon)
            gmaps = gmaps_url(u_lat, u_lon, t_lat, t_lon)

    return merged, ll_dist, gmaps

def merge_pair(r1: pd.Series, r2: pd.Series) -> tuple[pd.Series, bool, Optional[float], Optional[str]]:
    """
    Merge two duplicate crash records.

    Returns:
        merged: Merged record
        resolved: True if successfully merged without conflicts
        ll_dist: Distance in feet between conflicting lat/lons (if any)
        gmaps: Google Maps URL for conflicting lat/lons (if any)
    """
    merged = r1.copy()
    resolved = True
    ll_dist = None
    gmaps = None

    # Fields to merge (prefer non-null)
    merge_fields = [
        'SRI (Standard Route Identifier)',
        'Mile Post',
        'Direction From Cross Street',
        'Cross Street Name',
    ]

    for field in merge_fields:
        v1, v2 = r1[field], r2[field]
        null1 = pd.isna(v1) or (isinstance(v1, str) and v1.strip() == '')
        null2 = pd.isna(v2) or (isinstance(v2, str) and v2.strip() == '')

        if null1 and not null2:
            merged[field] = v2
        elif not null1 and not null2 and v1 != v2:
            # Have conflict - for now keep r1
            resolved = False

    # Cross Street Name + Direction should be taken together
    csn1, dir1 = r1['Cross Street Name'], r1['Direction From Cross Street']
    csn2, dir2 = r2['Cross Street Name'], r2['Direction From Cross Street']

    csn1_empty = pd.isna(csn1) or (isinstance(csn1, str) and csn1.strip() == '')
    csn2_empty = pd.isna(csn2) or (isinstance(csn2, str) and csn2.strip() == '')

    if csn1_empty and not csn2_empty:
        merged['Cross Street Name'] = csn2
        merged['Direction From Cross Street'] = dir2

    # Normalize and merge text fields
    for field in ['Police Department', 'Crash Location', 'Cross Street Name']:
        v1, v2 = r1[field], r2[field]

        if field == 'Police Department':
            n1, n2 = normalize_pd_name(v1), normalize_pd_name(v2)
        else:
            n1, n2 = normalize_street_name(v1), normalize_street_name(v2)

        if n1 == n2:
            # Normalized names match - prefer the one with more detail (longer)
            if pd.notna(v1) and pd.notna(v2):
                merged[field] = v1 if len(str(v1)) >= len(str(v2)) else v2
            elif pd.notna(v1):
                merged[field] = v1
            elif pd.notna(v2):
                merged[field] = v2
        elif n1 and n2:
            # Different normalized values
            resolved = False

    # Lat/Lon: prefer more precise (more decimal places), calculate distance if different
    lat1, lon1 = r1['Latitude'], r1['Longitude']
    lat2, lon2 = r2['Latitude'], r2['Longitude']

    if pd.notna(lat1) and pd.notna(lat2) and pd.notna(lon1) and pd.notna(lon2):
        if (lat1, lon1) != (lat2, lon2):
            ll_dist = ll_distance_feet(lat1, lon1, lat2, lon2)
            gmaps = gmaps_url(lat1, lon1, lat2, lon2)

            # Prefer the one with more precision (more decimal places)
            lat1_prec = len(str(lat1).split('.')[-1]) if '.' in str(lat1) else 0
            lat2_prec = len(str(lat2).split('.')[-1]) if '.' in str(lat2) else 0
            lon1_prec = len(str(lon1).split('.')[-1]) if '.' in str(lon1) else 0
            lon2_prec = len(str(lon2).split('.')[-1]) if '.' in str(lon2) else 0

            total_prec1 = lat1_prec + lon1_prec
            total_prec2 = lat2_prec + lon2_prec

            if total_prec2 > total_prec1:
                merged['Latitude'] = lat2
                merged['Longitude'] = lon2

            # If distance > 100 feet, mark as unresolved
            if ll_dist and ll_dist > 100:
                resolved = False
    elif pd.isna(lat1) and pd.notna(lat2):
        merged['Latitude'] = lat2
        merged['Longitude'] = lon2

    return merged, resolved, ll_dist, gmaps

def main():
    from utz import err

    # Load duplicates
    err("Loading 2023 crash duplicates...")
    dupes = pd.read_parquet('njdot/data/2023/NewJersey2023Accidents.pqt')

    pk_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    dupe_mask = dupes.duplicated(pk_cols, keep=False)
    dupes = dupes[dupe_mask].copy()

    # Add original line number (index + 1 for 1-based, +1 for header)
    dupes['lineno'] = dupes.index + 2

    err(f"Found {len(dupes)} duplicate records")

    # Classify case for each record
    text_fields = ['Police Department', 'Crash Location', 'Cross Street Name']
    dupes['case_class'] = dupes.apply(lambda r: classify_case(r, text_fields), axis=1)

    # Group by PK
    grouped = dupes.groupby(pk_cols)

    merged_records = []
    dupe_records = []
    group_idx = 0  # Autoincrement for each duplicate group
    ucase_tcase_merges = 0  # Count of ucase/tcase merges

    for pk, group in grouped:
        if len(group) == 2:
            # Simple pair
            r1, r2 = group.iloc[0], group.iloc[1]

            # Check if this is a ucase/tcase pair
            cases = sorted([r1['case_class'], r2['case_class']])
            is_ucase_tcase = (cases == ['tcase', 'ucase'])

            if is_ucase_tcase:
                # Identify which is which
                if r1['case_class'] == 'ucase':
                    ucase, tcase = r1, r2
                else:
                    ucase, tcase = r2, r1

                # Use ucase/tcase merge strategy (with metadata tracking)
                merged, ll_dist, gmaps = merge_ucase_tcase_with_metadata(ucase, tcase)
                resolved = True  # ucase/tcase merges are always resolved
                merge_strategy = 'ucase_tcase'
                ucase_tcase_merges += 1
            else:
                # Use old merge strategy
                merged, resolved, ll_dist, gmaps = merge_pair(r1, r2)
                merge_strategy = 'fallback'

            merged_records.append(merged)

            # Add to dupe records with metadata
            for idx, r in enumerate([r1, r2]):
                dupe_rec = r.copy()
                dupe_rec['resolved'] = resolved
                dupe_rec['merge_strategy'] = merge_strategy
                dupe_rec['ll_dist'] = ll_dist
                dupe_rec['gmaps_url'] = gmaps
                dupe_rec['idx'] = idx  # Position within this duplicate group
                dupe_rec['group_idx'] = group_idx  # Autoincrement across all groups
                dupe_records.append(dupe_rec)
        else:
            # 3+ duplicates - compare each idx > 0 against idx=0
            r0 = group.iloc[0]
            lat0, lon0 = r0['Latitude'], r0['Longitude']

            for idx, (_, r) in enumerate(group.iterrows()):
                dupe_rec = r.copy()
                dupe_rec['resolved'] = False
                dupe_rec['merge_strategy'] = 'none'  # No merge for 3+ groups
                dupe_rec['idx'] = idx  # Position within this duplicate group
                dupe_rec['group_idx'] = group_idx  # Autoincrement across all groups

                if idx == 0:
                    # First record - no comparison
                    dupe_rec['ll_dist'] = None
                    dupe_rec['gmaps_url'] = None
                else:
                    # Compare against idx=0
                    lat_i, lon_i = r['Latitude'], r['Longitude']
                    dupe_rec['ll_dist'] = ll_distance_feet(lat0, lon0, lat_i, lon_i)
                    dupe_rec['gmaps_url'] = gmaps_url(lat0, lon0, lat_i, lon_i)

                dupe_records.append(dupe_rec)

        group_idx += 1  # Increment for next group

    # Create DataFrames
    all_merges_df = pd.DataFrame(merged_records)
    dupes_df = pd.DataFrame(dupe_records)

    # Split dupes into merged vs unmerged
    merged_df = dupes_df[dupes_df['resolved']].copy()
    unmerged_df = dupes_df[~dupes_df['resolved']].copy()

    # Extract only the cleanly resolved merges
    # Need to map back from dupe records to their merge records
    pk_cols = ['County Code', 'Municipality Code', 'Department Case Number']
    resolved_pks = merged_df[pk_cols].drop_duplicates()

    # Filter all_merges_df to only include resolved cases
    merges_df = all_merges_df.merge(
        resolved_pks,
        on=pk_cols,
        how='inner'
    )

    resolved_count = len(merges_df)
    err(f"Successfully merged {resolved_count} of {len(grouped)} duplicate cases")
    err(f"  UCASE/TCASE merges: {ucase_tcase_merges}")
    err(f"  Fallback merges: {resolved_count - ucase_tcase_merges}")

    # Write outputs
    import os
    merges_path = 'njdot/data/2023/crash_dupes/merges.pqt'
    merges_all_path = 'njdot/data/2023/crash_dupes/merges-all.pqt'
    merged_path = 'njdot/data/2023/crash_dupes/merged.pqt'
    unmerged_dir = 'njdot/data/2023/crash_dupes/unmerged'

    merges_df.to_parquet(merges_path, index=False)
    err(f"Wrote {merges_path}: {len(merges_df)} cleanly merged records")

    all_merges_df.to_parquet(merges_all_path, index=False)
    err(f"Wrote {merges_all_path}: {len(all_merges_df)} attempted merges (fallback)")

    merged_df.to_parquet(merged_path, index=False)
    err(f"Wrote {merged_path}: {len(merged_df)} successfully merged dupe records")

    # Write unmerged records split by position index
    os.makedirs(unmerged_dir, exist_ok=True)

    # Write all unmerged records
    unmerged_all_path = f'{unmerged_dir}/all.pqt'
    unmerged_df.to_parquet(unmerged_all_path, index=False)
    err(f"Wrote {unmerged_all_path}: {len(unmerged_df)} unmerged records (all)")

    # Write split by position
    max_idx = int(unmerged_df['idx'].max())
    for idx in range(max_idx + 1):
        idx_df = unmerged_df[unmerged_df['idx'] == idx]
        idx_path = f'{unmerged_dir}/{idx}.pqt'
        idx_df.to_parquet(idx_path, index=False)
        err(f"Wrote {idx_path}: {len(idx_df)} unmerged records (position {idx})")

    # Summary stats
    err("\nResolution summary:")
    err(f"  Total duplicate cases: {len(grouped)}")
    err(f"  Resolved: {resolved_count}")
    err(f"  Unresolved: {len(grouped) - resolved_count}")

    if dupes_df['ll_dist'].notna().any():
        ll_dists = dupes_df['ll_dist'].dropna()
        err(f"\nLat/Lon distance stats (feet):")
        err(f"  Mean: {ll_dists.mean():.1f}")
        err(f"  Median: {ll_dists.median():.1f}")
        err(f"  Max: {ll_dists.max():.1f}")

if __name__ == '__main__':
    main()
