from functools import partial

import pandas as pd
from numpy import nan
from typing import Optional
from utz import sxs

from nj_crashes.utils.log import err
from njdot import vehicles, crashes
from njdot.load import Years, load_tbl, normalize

renames = {
    'Year': 'year',
    'Vehicle Number': 'vn',
    'Occupant Number': 'on',
    'Physical Condition': 'condition',
    'Position In/On Vehicle': 'pos',
    'Ejection Code': 'eject',
    'Age': 'age',
    'Sex': 'sex',
    'Location of Most Severe Injury': 'inj_loc',
    'Type of Most Severe Physical Injury': 'inj_type',
    'Refused Medical Attention': 'med_refused',
    'Safety Equipment Available': 'safety_avail',
    'Safety Equipment Used': 'safety_used',
    'Airbag Deployment': 'airbag',
    'Hospital Code': 'hospital',
}

astype = {
    'vn': int,
    'on': 'Int8',  # Made nullable to handle empty strings in 2023 data
    'condition': 'Int8',
    'pos': 'Int8',
    'eject': 'Int8',
    'inj_loc': 'Int8',
    'inj_type': 'Int8',
    'safety_avail': 'Int8',
    'safety_used': 'Int8',
    'airbag': 'Int8',

    # 'med_refused': 'Int8',  # TODO: triage a 'Y'?
    # 'hospital': 'Int16',    # TODO: drop a few non-numeric values?
}

pk_cols = vehicles.pk_cols + ['on']


def map_year_df(df):
    # Clean and parse age
    df['age'] = df.age.replace('M$', '', regex=True).replace('', nan)
    df['age'] = pd.to_numeric(df['age'], errors='coerce')

    # Fix invalid age values: -1 and coded values (117, 120, 122, 123)
    # Earlier years leave age blank when unknown, resulting in natural ~4% NaN rate
    # 2023 uses coded values instead of leaving age blank
    df['age'] = df['age'].where((df['age'] >= 0) & (df['age'] <= 110), nan)

    # Convert to nullable Int8 (handles NaN properly)
    df['age'] = df['age'].astype(pd.Int8Dtype())

    # Fix 2023 data quality issues with occupant numbers:
    # 1. Duplicate (vehicle, on) pairs from crash duplication (4,406 of 9,002 records)
    #    → Smart merge: keep occupants from TCASE crashes
    # 2. Empty/hex-corrupted values (55,189 records: 48,228 empty + 6,961 hex)
    #    → Renumber all occupants [1, N] per vehicle
    # 3. Remaining full duplicates
    #    → Drop
    #
    # Order matters: Must smart-merge BEFORE renumbering (merge relies on line numbers)
    import os
    vehicle_key = ['year', 'cc', 'mc', 'case', 'vn']
    occupant_key = vehicle_key + ['on']

    year = df['year'].iloc[0]

    # Optionally write duplicate side-outputs for analysis (before any changes)
    write_dupe_outputs = os.environ.get('NJDOT_WRITE_DUPE_OUTPUTS', '').lower() in ('1', 'true', 'yes')
    if write_dupe_outputs:
        from njdot.dupe_utils import analyze_and_write_dupes
        # Need to use original column names
        df_with_orig_cols = df.copy()
        df_with_orig_cols['County Code'] = df_with_orig_cols['cc']
        df_with_orig_cols['Municipality Code'] = df_with_orig_cols['mc']
        df_with_orig_cols['Department Case Number'] = df_with_orig_cols['case']
        df_with_orig_cols['Vehicle Number'] = df_with_orig_cols['vn']
        df_with_orig_cols['Occupant Number'] = df_with_orig_cols['on']
        pk_orig = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number', 'Occupant Number']
        analyze_and_write_dupes(df_with_orig_cols, pk_orig, 'occupants', year, write_outputs=True)

    # Step 1: Smart merge duplicates from crash duplication (2023 only)
    if year == 2023:
        dupe_mask = df.duplicated(occupant_key, keep=False)
        if dupe_mask.any():
            from njdot.merge_vo_dupes import merge_vo_duplicates

            # merge_vo_duplicates expects original column names + _orig_lineno
            # Rename columns back to original names for merge
            df = df.rename(columns={
                'cc': 'County Code',
                'mc': 'Municipality Code',
                'case': 'Department Case Number',
                'vn': 'Vehicle Number',
                'on': 'Occupant Number',
            })
            pk_orig = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number', 'Occupant Number']

            df = merge_vo_duplicates(df, pk_orig, 'occupants', year)

            # Rename back to internal names
            df = df.rename(columns={
                'County Code': 'cc',
                'Municipality Code': 'mc',
                'Department Case Number': 'case',
                'Vehicle Number': 'vn',
                'Occupant Number': 'on',
            })
            df = df.drop(columns=['_orig_lineno'], errors='ignore')

    # Step 2: Drop remaining full duplicates
    before = len(df)
    df = df.drop_duplicates(keep='first')
    after = len(df)
    if before != after:
        from nj_crashes.utils.log import err
        err(f"Dropped {before - after:,} full duplicate occupant records")

    # Step 3: Renumber all occupants [1, N] within each vehicle
    # This fixes empty/corrupted occupant numbers and any remaining duplicates
    df['on'] = df.groupby(vehicle_key).cumcount() + 1
    df['on'] = df['on'].astype(pd.Int8Dtype())

    return df


def map_df(df, fix_missing_vid: bool = True, drop: bool = True):
    # Fix occupant cc/mc using PK mapping table
    # Crashes undergo geocoding (Port Authority, empty municipality fixes) that updates cc/mc,
    # but occupants retain original cc/mc from raw data
    # Mapping table: (year, cc0, mc0, case) → (cc, mc) tracks all PK transformations
    from njdot.paths import DOT_DATA
    import os

    mapping_path = f'{DOT_DATA}/crash_pk_mappings.parquet'
    if os.path.exists(mapping_path):
        err("Fixing occupant cc/mc using PK mapping table")
        mapping = pd.read_parquet(mapping_path)

        # Merge on (year, cc, mc, case) to get updated cc/mc
        # Note: occupants have original cc/mc, which match mapping's cc0/mc0
        df_with_mapping = df.merge(
            mapping[['year', 'cc0', 'mc0', 'case', 'cc', 'mc']],
            left_on=['year', 'cc', 'mc', 'case'],
            right_on=['year', 'cc0', 'mc0', 'case'],
            how='left',
            suffixes=('_old', '')
        )

        # Update cc/mc where mapping exists
        # For rows without mapping, cc/mc will be NaN, so fill with original values
        # Note: mc may be float64 (combined codes like 9901.0 for Port Authority)
        df['cc'] = df_with_mapping['cc'].fillna(df['cc']).astype('int8')
        # Convert mc to float to handle combined codes from crashes
        df['mc'] = df_with_mapping['mc'].fillna(df['mc'].astype('float64'))

        num_updated = df_with_mapping['cc'].notna().sum()
        err(f"  Updated {num_updated:,} occupant PKs from mapping table")
    else:
        err(f"Warning: PK mapping table not found at {mapping_path}, skipping cc/mc fix")

    err("Merging occupants with crashes...")
    try:
        dfc = normalize(df, 'crash_id', crashes.load, drop=drop)
        err(f"✓ Crashes merge successful: {len(dfc):,} occupants")
    except Exception as e:
        err(f"✗ Crashes merge FAILED: {e}")
        raise

    if fix_missing_vid:
        # no_vid_mask = dfc.vehicle_id.isna()
        # no_vid = dfc[no_vid_mask]
        # assert len(no_vid) == 1, no_vid
        bad_crash_id = 12410270
        # assert no_vid.index.tolist() == [bad_crash_id], no_vid
        # Only fix if this crash exists in the loaded data
        if bad_crash_id in dfc.index:
            assert dfc.loc[bad_crash_id, 'vn'] == 25
            err(f"Crash {bad_crash_id}: fixing bad vehicle num, 25 → 2")
            dfc.loc[bad_crash_id, 'vn'] = 2
        # dfc = dfc.astype({ 'vehicle_id': 'int32' })

    err("Merging occupants with vehicles...")
    try:
        dfm = normalize(dfc, 'vehicle_id', vehicles.load, drop=drop, cols=['crash_id', 'vn'])
        err(f"✓ Vehicles merge successful: {len(dfm):,} occupants")
    except Exception as e:
        err(f"✗ Vehicles merge FAILED: {e}")
        err(f"   This is the merge that's failing!")
        raise
    if drop:
        dfm = sxs(dfc.crash_id, dfm)

    # Drop any remaining orphaned occupants (couldn't be fixed)
    orphans = dfm['crash_id'].isna() | dfm['vehicle_id'].isna()
    if orphans.any():
        num_orphans = orphans.sum()
        err(f"Dropping {num_orphans} orphaned occupants (couldn't match to crash/vehicle)")
        dfm = dfm[~orphans].copy()

    dfm.index = dfm.index.astype('int32')

    return dfm


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        pqt_path: Optional[str] = None,
        n_jobs: int = 0,
        cols: Optional[list[str]] = None,
        fix_missing_vid: bool = True,
        drop: bool = True,
):
    df = load_tbl(
        'occupants',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=partial(map_df, fix_missing_vid=fix_missing_vid, drop=drop),
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        pqt_path=pqt_path,
        n_jobs=n_jobs,
    )
    return df
