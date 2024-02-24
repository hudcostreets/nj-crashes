from functools import cache

from typing import Literal

import pandas as pd

from nj_crashes.paths import COUNTY_CITY_CODES_PQT


@cache
def get_ccc() -> pd.DataFrame:
    return pd.read_parquet(COUNTY_CITY_CODES_PQT)


def update_mc(df: pd.DataFrame, tpe: Literal['sp', 'dot']) -> pd.DataFrame:
    ccc = get_ccc()
    on = ['cc', f'mc_{tpe}']
    idx_col = df.index.name
    return (
        df
        .reset_index()
        .merge(ccc[on + ['mc_gin']], on=on, how='left')
        .set_index(idx_col)
    )
