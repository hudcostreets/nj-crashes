from dataclasses import dataclass, asdict

import pandas as pd
from pandas import read_parquet, isna
from typing import Union, Tuple
from utz import cached_property, DF, sxs, err

from nj_crashes.geo import is_nj_ll
from nj_crashes.sri.mp05 import get_mp05_map
from njdot.codes import CrashSeverity
from njdot.data import END_YEAR

Year = Union[str, int]
Years = Union[Year, list[Year]]


def load(
        years: Years = END_YEAR,
        county: str = None,
):
    if isinstance(years, str):
        years = years.split(',')
    elif isinstance(years, int):
        years = [str(years)]
    dfs = []
    for year in years:
        crashes = read_parquet(f'njdot/data/{year}/NewJersey{year}Accidents.pqt')
        crashes = crashes.rename(columns={
            'SRI (Standard Route Identifier)': 'sri',
            'Mile Post': 'mp',
            'Latitude': 'lat',
            'Longitude': 'lon',
        })
        if county:
            crashes = crashes[crashes['County Name'].str.lower() == county.lower()]
        crashes['lon'] = -crashes['lon']  # Longitudes all come in positive, but are actually supposed to be negative (NJ ⊂ [-75, -73])
        crashes['Severity'] = crashes['Severity'].apply(lambda s: CrashSeverity.CH2Name[s])
        dfs.append(crashes)
    return pd.concat(dfs)


def geocode_mp(r, sris):
    sri = r.sri
    mp = r.mp
    if isna(sri):
        return dict(reason="No SRI")
    if isna(mp):
        return dict(reason="No MP")
    if sri not in sris:
        return dict(reason='SRI not found')
    mp_lls = sris[sri]
    ll = mp_lls.get(mp)
    if ll:
        return asdict(ll)
    else:
        return dict(reason="MP didn't geocode")

@dataclass
class Crashes:
    df: pd.DataFrame

    @classmethod
    def load(cls, years: Years = END_YEAR, county: str = None):
        return cls(load(years, county))

    @cached_property
    def lls(self):
        df = self.df.copy()
        mp05_map = get_mp05_map()
        ll = DF(sxs(df.sri, df.mp).apply(geocode_mp, sris=mp05_map, axis=1).tolist())

        n = len(df)

        def pct(num):
            return int(num / n * 100)

        def replace(k):
            v = ll[k]
            missing = df[k].isna()
            num_missing = missing.sum()
            interpd = ~v.isna()
            num_interpd = interpd.sum()
            replace_idx = missing & interpd
            num_replace = replace_idx.sum()

            num_lls = n - num_missing + num_replace
            def pct_str(num, name):
                return f"{num} {name} ({pct(num)}%)"

            strs = [
                pct_str(num_replace, 'recovered'),
                pct_str(num_missing, 'missing'),
                pct_str(num_interpd, 'interpolated'),
                pct_str(num_lls, 'total lls'),
            ]

            err(f"{k}: {', '.join(strs)}")
            df.loc[replace_idx, k] = v

        replace('lat')
        replace('lon')
        df = df[~df.lon.isna()]
        return LLCrashes(df)

    def __getattr__(self, item):
        return getattr(self.df, item)

    def __len__(self):
        return len(self.df)

    def __getitem__(self, item):
        return self.df[item]

    def __repr__(self):
        return repr(self.df)

    def _repr_html_(self):
        return self.df._repr_html_()


@dataclass
class LLCrashes(Crashes):
    df: pd.DataFrame

    @cached_property
    def nj_mask(self) -> pd.Series:
        return self.df.apply(lambda r: is_nj_ll(r.lat, r.lon), axis=1)

    @cached_property
    def njs(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        df = self.df
        nj_mask = self.nj_mask
        nnj = df[~nj_mask]
        nj = df[nj_mask]
        return nj, nnj

    @cached_property
    def nj(self) -> 'LLCrashes':
        return LLCrashes(self.njs[0])

    @cached_property
    def nnj(self) -> 'LLCrashes':
        return LLCrashes(self.njs[1])
