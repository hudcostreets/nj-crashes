from functools import partial

from numpy import nan
from typing import Optional
from utz import sxs

from nj_crashes.utils.log import err
from njdot import vehicles, crashes
from njdot.load import Years, load_tbl, normalize, pk_base

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
    'on': 'int8',
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
    import pandas as pd
    from numpy import nan

    # Clean and parse age
    df['age'] = df.age.replace('M$', '', regex=True).replace('', nan)
    df['age'] = pd.to_numeric(df['age'], errors='coerce')

    # Fix 2023 regression: cap ages at 110
    # 2023 uses coded values (117, 120, 122, 123) instead of leaving age blank
    # Earlier years leave age blank when unknown, resulting in natural ~4% NaN rate
    if 'year' in df.columns and (df['year'] == 2023).any():
        df['age'] = df['age'].where(df['age'] <= 110, nan)

    df['age'] = df['age'].astype('Int8')
    return df


def map_df(df, fix_missing_vid: bool = True, drop: bool = True):
    err("Merging occupants with crashes")
    dfc = normalize(df, 'crash_id', crashes.load, drop=drop)

    if fix_missing_vid:
        # no_vid_mask = dfc.vehicle_id.isna()
        # no_vid = dfc[no_vid_mask]
        # assert len(no_vid) == 1, no_vid
        bad_crash_id = 12410270
        # assert no_vid.index.tolist() == [bad_crash_id], no_vid
        assert dfc.loc[bad_crash_id, 'vn'] == 25
        err(f"Crash {bad_crash_id}: fixing bad vehicle num, 25 → 2")
        dfc.loc[bad_crash_id, 'vn'] = 2
        # dfc = dfc.astype({ 'vehicle_id': 'int32' })

    err("Merging occupants with vehicles")
    dfm = normalize(dfc, 'vehicle_id', vehicles.load, drop=drop, cols=['crash_id', 'vn'])
    if drop:
        dfm = sxs(dfc.crash_id, dfm)

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
