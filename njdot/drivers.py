from functools import partial
from typing import Optional

from njdot.load import Years, load_tbl
from njdot.pedestrians import map_year_df, map_df

renames = {
    'Year': 'year',
    'Vehicle Number': 'vn',
    **{
        f'{c} {i}': f'{c.lower()}{i}'
        for i in range(1, 5)
        for c in ['Charge', 'Summons']
    },
    'Driver City': 'city',
    'Driver State': 'state',
    'Driver Zip Code': 'zip',
    'Driver License State': 'license_state',
    'Driver DOB': 'dob',
    'Driver Sex': 'sex',
    'Alcohol Test Given': 'alc_test_given',
    'Alcohol Test Type': 'alc_test_type',
    'Alcohol Test Results': 'alc_test_results',
    'Driver Physical Status 1': 'status1',
    'Driver Physical Status 2': 'status2',
}
astype = {
    'vn': 'int8',
    'status1': 'Int8',
    'status2': 'Int8',
}


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
        'drivers',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=partial(map_df, tpe='drivers'),
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        pqt_path=pqt_path,
        n_jobs=n_jobs,
    )
    return df
