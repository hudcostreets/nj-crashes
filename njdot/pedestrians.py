from functools import partial

from numpy import nan
from typing import Optional

from nj_crashes.utils.log import err
from njdot import crashes
from njdot.load import Years, load_tbl, normalize, pk_base

renames = {
    'Year': 'year',
    'Pedestrian Number': 'pn',
    'Physical Condition': 'condition',
    'Address City': 'city',
    'Address State': 'state',
    'Address Zip': 'zip',
    'Date of Birth': 'dob',
    'Age': 'age',
    'Sex': 'sex',
    'Traffic Controls': 'traffic_controls',
    'Contributing Circumstances 1': 'cir1',
    'Contributing Circumstances 2': 'cir2',
    'Location of Most Severe Injury': 'inj_loc',
    'Type of Most Severe Physical Injury': 'inj_type',
    'Refused Medical Attention': 'med_refused',
    'Safety Equipment Used': 'safety_used',
    'Hospital Code': 'hospital',
    'Pre-Crash Action': 'act',
    'Direction of Travel': 'dir',
    **{
        f'{c} {i}': f'{c.lower()}{i}'
        for i in range(1, 5)
        for c in ['Charge', 'Summons']
    },
    'Physical Status 1': 'status1',
    'Physical Status 2': 'status2',
    'Is Bicyclist?': 'cyclist',
    'Is Other?': 'other',
    'Alcohol Test Given': 'alc_test_given',
    'Alcohol Test Type': 'alc_test_type',
    'Alcohol Test Results': 'alc_test_results',
}

astype = {
    'pn': 'Int8',  # Made nullable to handle empty strings in 2023 data (will be filled)
    'condition': 'Int8',
    'traffic_controls': 'Int8',
    'cir1': 'Int8',
    'cir2': 'Int8',
    'dir': 'Int8',
    'act': 'Int8',
    'inj_loc': 'Int8',
    'inj_type': 'Int8',
    'med_refused': 'Int8',
    'safety_used': 'Int8',
    'status1': 'Int8',
    'status2': 'Int8',
}


def map_year_df(df):
    import pandas as pd
    df = df.drop(columns=['Multi Charge Flag'])
    if 'age' in df:
        # Convert age string to numeric, handling NaN properly with nullable Int8
        df['age'] = pd.to_numeric(df.age.replace('M$', '', regex=True).replace('', nan), errors='coerce')
        df['age'] = df['age'].astype(pd.Int8Dtype())

    # Fix 2023 data quality issues with pedestrian numbers (same as occupants):
    # Drop full duplicates, then renumber all pedestrians [1, N] per crash
    import os
    crash_key = ['year', 'cc', 'mc', 'case']
    pedestrian_key = crash_key + ['pn']

    # Optionally write duplicate side-outputs for analysis
    write_dupe_outputs = os.environ.get('NJDOT_WRITE_DUPE_OUTPUTS', '').lower() in ('1', 'true', 'yes')
    if write_dupe_outputs and len(df) > 0:
        year = df['year'].iloc[0]
        from njdot.dupe_utils import analyze_and_write_dupes
        # Analyze before renumbering to capture original duplicate patterns
        analyze_and_write_dupes(df, pedestrian_key, 'pedestrians', year, write_outputs=True)

    # Drop full duplicate records (all columns identical, keeps first occurrence)
    before = len(df)
    df = df.drop_duplicates(keep='first')
    after = len(df)
    if before != after:
        from nj_crashes.utils.log import err
        err(f"Dropped {before - after:,} full duplicate pedestrian records")

    # Renumber all pedestrians [1, N] within each crash (vectorized for performance)
    df['pn'] = df.groupby(crash_key).cumcount() + 1
    df['pn'] = df['pn'].astype(pd.Int8Dtype())

    return df


def map_df(p, tpe):
    # Fix pedestrian/driver cc/mc using PK mapping table
    # Crashes undergo geocoding (Port Authority, empty municipality fixes) that updates cc/mc,
    # but pedestrians/drivers retain original cc/mc from raw data
    # Mapping table: (year, cc0, mc0, case) → (cc, mc) tracks all PK transformations
    from njdot.paths import DOT_DATA
    import os
    import pandas as pd

    mapping_path = f'{DOT_DATA}/crash_pk_mappings.parquet'
    if os.path.exists(mapping_path):
        err(f"Fixing {tpe} cc/mc using PK mapping table")
        mapping = pd.read_parquet(mapping_path)

        # Merge on (year, cc, mc, case) to get updated cc/mc
        # Note: pedestrians/drivers have original cc/mc, which match mapping's cc0/mc0
        p_with_mapping = p.merge(
            mapping[['year', 'cc0', 'mc0', 'case', 'cc', 'mc']],
            left_on=['year', 'cc', 'mc', 'case'],
            right_on=['year', 'cc0', 'mc0', 'case'],
            how='left',
            suffixes=('_old', '')
        )

        # Update cc/mc where mapping exists
        # For rows without mapping, cc/mc will be NaN, so fill with original values
        # Note: mc may be float64 (combined codes like 9901.0 for Port Authority)
        p['cc'] = p_with_mapping['cc'].fillna(p['cc']).astype('int8')
        # Convert mc to float to handle combined codes from crashes
        p['mc'] = p_with_mapping['mc'].fillna(p['mc'].astype('float64'))

        num_updated = p_with_mapping['cc'].notna().sum()
        err(f"  Updated {num_updated:,} {tpe} PKs from mapping table")
    else:
        err(f"Warning: PK mapping table not found at {mapping_path}, skipping cc/mc fix")

    err(f"Merging {tpe} with crashes")
    p = normalize(p, 'crash_id', crashes.load)

    # Drop any remaining orphaned records (couldn't match to crash)
    orphans = p['crash_id'].isna()
    if orphans.any():
        num_orphans = orphans.sum()
        err(f"Dropping {num_orphans} orphaned {tpe} (couldn't match to crash)")
        p = p[~orphans].copy()

    p.index = p.index.astype('int32')
    for i in range(1, 5):
        for c in ['charge', 'summons']:
            col = f'{c}{i}'
            if col in p:
                p[col] = p[col].replace('(?:NONE|N/A)', '', regex=True).fillna('')
    return p


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        pqt_path: Optional[str] = None,
        n_jobs: int = 0,
        cols: Optional[list[str]] = None,
):
    df = load_tbl(
        'pedestrians',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=partial(map_df, tpe='pedestrians'),
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        pqt_path=pqt_path,
        n_jobs=n_jobs,
    )
    return df
