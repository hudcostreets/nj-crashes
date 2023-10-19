import pandas as pd
from pandas import read_parquet
from typing import Union

from njdot.codes import CrashSeverity

Year = Union[str, int]
Years = Union[Year, list[Year]]


def load(
        years: Years = '2020',
        county: str = None,
):
    if isinstance(years, str):
        years = years.split(',')
    elif isinstance(years, int):
        years = [str(years)]
    dfs = []
    for year in years:
        crashes = read_parquet(f'njdot/data/{year}/NewJersey{year}Accidents.pqt')
        sri_col = 'SRI (Standard Route Identifier)' if int(year) < 2017 else 'SRI (Std Rte Identifier)'
        crashes = crashes.rename(columns={ sri_col: 'SRI', 'MilePost': 'MP' })
        if county:
            crashes = crashes[crashes['County Name'].str.lower() == county.lower()]
        crashes['Longitude'] = -crashes['Longitude']  # Longitudes all come in positive, but are actually supposed to be negative (NJ ⊂ [-75, -73])
        crashes['Severity'] = crashes['Severity'].apply(lambda s: CrashSeverity.CH2Name[s])
        dfs.append(crashes)
    return pd.concat(dfs)
