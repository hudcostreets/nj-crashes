from functools import partial

from numpy import nan
from typing import Optional

from nj_crashes.utils.log import err
from njdot import crashes
from njdot.load import Years, load_tbl, normalize

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
    'pn': 'int8',
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
    df = df.drop(columns=['Multi Charge Flag'])
    if 'age' in df:
        df['age'] = df.age.replace('M$', '', regex=True).replace('', nan).astype('Int8')
    return df


def map_df(p, tpe):
    err(f"Merging {tpe} with crashes")
    p = normalize(p, 'crash_id', crashes.load)
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
