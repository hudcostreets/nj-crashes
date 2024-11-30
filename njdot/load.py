#!/usr/bin/env python
from os import stat, cpu_count
from os.path import exists

import pandas as pd
from humanize import naturalsize
from inspect import getfullargspec
from numpy import nan
from pandas import read_parquet
from typing import Union, Optional, Callable, Protocol
from utz import err, sxs

from nj_crashes.paths import relpath
from njdot import NJDOT_DIR
from njdot.data import YEARS, cn2cc
from njdot.paths import DOT_DATA
from njdot.tbls import Tbl, TBL_TO_TYPE, Type

Year = int
Years = Union[Year, list[Year]]

INDEX_NAME = 'id'
pk_renames = {
    'County Code': 'cc',
    'Municipality Code': 'mc',
    'Department Case Number': 'case',
}
pk_base = ['year'] + list(pk_renames.values())
pk_astype = {
    'cc': 'int8',
    'mc': 'int8',
    'year': 'int16',
}


def print_hists(df: pd.DataFrame, cols: Optional[list[str]] = None):
    for k in df:
        if cols is None or k in cols:
            print(df[k].value_counts(dropna=False).sort_index())


class Collable(Protocol):
    def __call__(self, cols: list[str]) -> pd.DataFrame:
        ...


class MapYearDF1(Protocol):
    def __call__(self, df: pd.DataFrame) -> pd.DataFrame:
        ...


class MapYearDF2(Protocol):
    def __call__(self, df: pd.DataFrame, year: int) -> pd.DataFrame:
        ...


def normalize(
    df: pd.DataFrame,
    id: str,
    r_fn: Collable,
    drop: bool = True,
    cols: Optional[list[str]] = None,
    dtype: Optional[str] = None,
) -> pd.DataFrame:
    if cols:
        left_on = right_on = cols
    else:
        left_on = pk_base
        right_on = [ 'mc_dot' if c == 'mc' else c for c in pk_base ] if id == 'crash_id' else pk_base

    dfb = df[left_on]
    r = r_fn(cols=right_on + [INDEX_NAME])
    m = dfb.merge(
        r.rename(columns={ 'id': id }),
        left_on=left_on,
        right_on=right_on,
        how='left',
        validate='m:1',
    )
    if drop:
        drop_cols = [ c for c in set(left_on + right_on) if c in df ]
        err(f"Dropping cols: {drop_cols}")
        df = df.drop(columns=drop_cols)
    id_col = m[id]
    if dtype:
        id_col = id_col.astype(dtype)
    dfm = sxs(id_col, df)
    dfm.index.name = INDEX_NAME
    return dfm


def load_year_df(
    year: int,
    typ: Type,
    tbl: str,
    renames: dict[str, str],
    astype: dict[str, Union[str, type]],
    opt_ints: dict[str, str],
    county: str,
    map_year_df: Union[None, MapYearDF1, MapYearDF2] = None,
):
    df = read_parquet(f'{NJDOT_DIR}/data/{year}/NewJersey{year}{typ}.pqt')
    df = df.rename(columns=renames)
    df = df.astype({ k: v for k, v in astype.items() if k in df })
    for k, v in opt_ints.items():
        if k in df:
            df[k] = df[k].replace(r'^[\?\*]?$', nan, regex=True).replace('0?', '00', regex=False).astype(v)

    if county:
        df = df[df.cn.str.lower() == county.lower()]

    if 'year' in df:
        years_col = df.year
    else:
        years_col = df.dt.dt.year.rename('year')
        df['year'] = years_col

    wrong_year = years_col != int(year)
    if wrong_year.any():
        num_wrong_year = wrong_year.sum()
        err(f'{num_wrong_year} {tbl} for year {year} have wrong year: {years_col.value_counts()}')

    if map_year_df:
        spec = getfullargspec(map_year_df)
        kwargs = dict(year=year) if 'year' in spec.args else {}
        df = map_year_df(df, **kwargs)

    return df


def load_tbl(
    tbl: Tbl,
    years: Years = None,
    county: str = None,
    n_jobs: int = 0,
    read_pqt: Optional[bool] = None,
    write_pqt: bool = False,
    pqt_path: Optional[str] = None,
    renames: Optional[dict[str, str]] = None,
    astype: Optional[dict[str, Union[str, type]]] = None,
    pk_cols: Optional[list[str]] = None,
    cols: Optional[list[str]] = None,
    map_year_df: Union[None, MapYearDF1, MapYearDF2] = None,
    map_df: Optional[Callable[[pd.DataFrame], pd.DataFrame]] = None,
) -> pd.DataFrame:
    if isinstance(years, str):
        years = list(map(int, years.split(',')))
    elif isinstance(years, int):
        years = [years]
    elif years is None:
        years = YEARS

    typ = TBL_TO_TYPE[tbl]

    pqt_path = pqt_path or f'{DOT_DATA}/{tbl}.parquet'
    if read_pqt or (read_pqt is None and exists(pqt_path) and not write_pqt):
        err(f"Reading {relpath(pqt_path)}")
        df = read_parquet(pqt_path, columns=cols)
        if years != YEARS:
            df = df[df.year.isin(years)]
        if county:
            cc = cn2cc[county.title()]
            df = df[df.cc == cc]
        return df
    else:
        err("Computing")

    renames = { **pk_renames, **(renames or {}) }
    astype = { **pk_astype, **(astype or {}) }
    opt_ints = {
        k: v
        for k, v in astype.items()
        if isinstance(v, str) and v.startswith('Int')
    }
    astype = {
        k: v
        for k, v in astype.items()
        if k not in opt_ints
    }
    kwargs = dict(
        typ=typ,
        tbl=tbl,
        renames=renames,
        astype=astype,
        opt_ints=opt_ints,
        county=county,
        map_year_df=map_year_df,
    )
    if len(years) > 1 and n_jobs != 1:
        from joblib import Parallel, delayed
        if not n_jobs:
            n_jobs = cpu_count()
        err(f"Parallelizing {len(years)} years {n_jobs} ways")
        dfs = Parallel(n_jobs=n_jobs)(
            delayed(load_year_df)(year=year, **kwargs)
            for year in years
        )
    else:
        dfs = [
            load_year_df(year=year, **kwargs)
            for year in years
        ]

    df = pd.concat(dfs)

    pk_cols = pk_cols or []
    pk_cols = pk_base + pk_cols
    df = df.sort_values(pk_cols).reset_index(drop=True)
    if cols:
        df = df[cols]
    cols = pk_cols + [ col for col in df if col not in pk_cols ]
    df = df[cols]
    df.index.name = INDEX_NAME

    if map_df:
        df = map_df(df)

    if write_pqt:
        df.reset_index().astype({ INDEX_NAME: 'int32' }).to_parquet(pqt_path, index=False)
        size = stat(pqt_path).st_size
        err(f"Wrote {pqt_path} ({len(df)} rows, {naturalsize(size)})")

    return df


CRASH_IDXS = [
    ('severity', 'dt', 'cc', 'mc'),
    ('cc', 'severity', 'dt'),
    ('cc', 'mc', 'severity', 'dt'),
    ('severity', 'ilat', 'ilon'),
    ('severity', 'icc', 'dt'),
]
