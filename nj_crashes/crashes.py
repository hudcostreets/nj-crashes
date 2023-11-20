from os.path import dirname

from math import sqrt

from dataclasses import dataclass, asdict

import pandas as pd
from pandas import read_parquet, isna
from typing import Union, Tuple
from utz import cached_property, DF, sxs, err

from nj_crashes.geo import is_nj_ll
from nj_crashes.sri.mp05 import get_mp05_map
from njdot import NJDOT_DIR
from njdot.codes import CrashSeverity
from njdot.data import END_YEAR, START_YEAR

Year = Union[str, int]
Years = Union[Year, list[Year]]


def load(
    years: Years = None,
    county: str = None,
    index: bool = True,
):
    if isinstance(years, str):
        years = years.split(',')
    elif isinstance(years, int):
        years = [str(years)]
    elif years is None:
        years = list(range(START_YEAR, END_YEAR))

    dfs = []
    for year in years:
        crashes = read_parquet(f'{NJDOT_DIR}/data/{year}/NewJersey{year}Accidents.pqt')
        crashes = crashes.rename(columns={
            'SRI (Standard Route Identifier)': 'sri',
            'Mile Post': 'mp',
            'Latitude': 'lat',
            'Longitude': 'lon',
        })
        if county:
            crashes = crashes[crashes['County Name'].str.lower() == county.lower()]
        years_col = crashes.Date.dt.year.rename('year')
        wrong_year = years_col != int(year)
        if wrong_year.any():
            num_wrong_year = wrong_year.sum()
            err(f'{num_wrong_year} crashes for year {year} have wrong year: {years_col.value_counts()}')
        crashes['year'] = years_col
        crashes['lon'] = -crashes['lon']  # Longitudes all come in positive, but are actually supposed to be negative (NJ ⊂ [-75, -73])
        crashes = crashes.rename(columns={ 'Severity': 'severity', })
        crashes['severity'] = crashes['severity'].apply(lambda s: CrashSeverity.CH2Name[s])
        if index:
            crashes = crashes.set_index([ 'year', 'County Code', 'Municipality Code', 'Department Case Number', ])
        dfs.append(crashes)
    df = pd.concat(dfs)
    if not index:
        df = df.reset_index(drop=True)
    return df


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
    def load(cls, years: Years = None, county: str = None):
        return cls(load(years, county))

    @cached_property
    def lls(self):
        df = self.df.copy()
        mp05_map = get_mp05_map()
        ll = DF(sxs(df.sri, df.mp).apply(geocode_mp, sris=mp05_map, axis=1).tolist(), index=df.index)

        n = len(df)
        if len(ll) != n:
            raise RuntimeError(f"Expected {n} geocoded lls, got {len(ll)}")

        def pct(num):
            return int(num / n * 100)

        def replace(k):
            v = ll[k]
            no_ll = df[k].isna()
            yes_ll = ~no_ll
            num_no_ll = no_ll.sum()
            no_mp = v.isna()
            yes_mp = ~no_mp
            num_yes_mp = yes_mp.sum()
            replace_idx = no_ll & yes_mp
            num_replace = replace_idx.sum()

            num_lls = n - num_no_ll + num_replace
            def pct_str(num, name):
                return f"{num} {name} ({pct(num)}%)"

            strs = [
                pct_str(num_replace, 'recovered'),
                pct_str(num_no_ll, 'missing'),
                pct_str(num_yes_mp, 'interpolated'),
                pct_str(num_lls, 'total lls'),
            ]

            err(f"{k}: {', '.join(strs)}")
            original = df[k].copy()
            interpd = v.copy()
            df[f'o{k}'] = original
            # df[f'i{k}'] = interpd

            # Original lat/lon, fall back to interpolated
            io = interpd.copy()
            io.loc[yes_ll & no_mp] = original
            # df[f'io{k}'] = io

            # Interpolated lat/lon, fall back to original
            oi = original.copy()
            oi.loc[no_ll & yes_mp] = interpd
            # df[f'oi{k}'] = oi

            # Use interpolated by default (originals seem to be less accurate)
            df[k] = io

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

    @cached_property
    def ll_hist(self):
        lls_count = self[['lon', 'lat', 'Severity']].value_counts().rename('lls_count')
        merged = self.merge(lls_count.reset_index(), on=['lon', 'lat', 'Severity'], how='left')
        merged['lls_count'] = merged['lls_count'].fillna(0)
        merged['radius'] = merged.lls_count.apply(sqrt)
        return LLCrashes(merged)
