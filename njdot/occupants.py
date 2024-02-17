from numpy import nan
from typing import Optional
from utz import sxs

from nj_crashes.utils.log import err
from njdot import vehicles, crashes
from njdot.load import Years, load_type, normalize, pk_base

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
    df['age'] = df.age.replace('M$', '', regex=True).replace('', nan).astype('Int8')
    return df


def map_df(df):
    err("Merging occupants with crashes")
    dfc = normalize(df, pk_base, 'crash_id', crashes.load)
    err("Merging occupants with vehicles")
    dfm = normalize(dfc, ['crash_id', 'vn'], 'vehicle_id', vehicles.load)
    dfm = sxs(dfc.crash_id, dfm)

    no_vid_mask = dfm.vehicle_id.isna()
    no_vid = dfm[no_vid_mask]
    assert len(no_vid) == 1, no_vid
    assert no_vid.index.tolist() == [12410270], no_vid
    dfm = dfm[~no_vid_mask].astype({ 'vehicle_id': 'int32' })

    return dfm


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        cols: Optional[list[str]] = None,
):
    df = load_type(
        'Occupants',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=map_df,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
    )
    return df
