#!/usr/bin/env python
from inspect import getfullargspec
from os import stat, cpu_count
from os.path import exists
from urllib.parse import urlparse

import click
import pandas as pd
from humanize import naturalsize
from numpy import nan
from pandas import read_parquet
from typing import Union, Optional, Callable, Protocol
from utz import err, sxs

from nj_crashes.utils import sql
from njdot import NJDOT_DIR
from njdot.data import YEARS, cn2cc
from njdot.paths import DOT_DATA, WWW_DOT
from njdot.rawdata import types_opt
from njdot.tbls import Type, TYPE_TO_TBL

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

TYPE_BASENAMES = {
    'Accidents': 'crashes.parquet',
    'Vehicles': 'vehicles.parquet',
    'Drivers': 'drivers.parquet',
    'Occupants': 'occupants.parquet',
    'Pedestrians': 'pedestrians.parquet',
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


def normalize(df: pd.DataFrame, cols: list[str], id: str, r_fn: Collable, drop: bool = True) -> pd.DataFrame:
    r = r_fn(cols=cols)
    dfb = df[cols]
    m = dfb.merge(
        r.reset_index().rename(columns={ 'id': id }),
        on=cols,
        how='left',
        validate='m:1',
    )
    if drop:
        df = df.drop(columns=cols)
    dfm = sxs(m[id], df)
    dfm.index.name = INDEX_NAME
    return dfm


def load_type(
        tpe: Type,
        years: Years = None,
        county: str = None,
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

    pqt_path = pqt_path or f'{DOT_DATA}/{TYPE_BASENAMES[tpe]}'
    if read_pqt or (read_pqt is None and exists(pqt_path) and not write_pqt):
        err(f"Reading {pqt_path}")
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
    dfs = []
    for year in years:
        df = read_parquet(f'{NJDOT_DIR}/data/{year}/NewJersey{year}{tpe}.pqt')
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
            err(f'{num_wrong_year} {tpe} for year {year} have wrong year: {years_col.value_counts()}')

        if map_year_df:
            spec = getfullargspec(map_year_df)
            kwargs = dict(year=year) if 'year' in spec.args else {}
            df = map_year_df(df, **kwargs)

        dfs.append(df)

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
        df.to_parquet(pqt_path)
        size = stat(pqt_path).st_size
        err(f"Wrote {pqt_path} ({len(df)} rows, {naturalsize(size)})")

    return df


crash_idxs = [
    ('severity', 'dt', 'cc', 'mc'),
    ('severity', 'ilat', 'ilon'),
    ('severity', 'icc', 'dt'),
]


S3_PREFIX = 's3://nj-crashes/njdot/data'


def run_type(tpe, input_pqt, path, replace, page_size, s3_url, no_s3):
    tbl = TYPE_TO_TBL[tpe]
    df = load_type(tpe, read_pqt=True, pqt_path=input_pqt)
    if not path:
        path = f'{WWW_DOT}/{tbl}.db'
    idxs = crash_idxs if tbl == 'crashes' else [('crash_id',)]
    sql.write(
        df=df,
        tbl=tbl,
        db_path=path,
        idxs=idxs,
        rm=not replace,
        replace=replace,
        page_size=page_size,
    )
    if not no_s3:
        s3_url = s3_url or f'{S3_PREFIX}/{tbl}.db'
        from boto3 import client
        s3 = client('s3')
        parsed = urlparse(s3_url)
        err(f'Uploading {path} to {s3_url}')
        s3.upload_file(path, Bucket=parsed.netloc, Key=parsed.path.lstrip('/'))


@click.command
@click.option('-i', '--input-pqt', help=f'Read from this parquet file (default: {DOT_DATA}/<type>.parquet`')
@click.option('-j', '--num-jobs', 'n_jobs', type=int, default=0, help='Number of jobs to run in parallel')
@click.option('-r', '--replace', is_flag=True, help='Pass `if_exists="replace"` to `DataFrame.to_sql`')
@click.option('-s', '--page-size', type=int, default=2**16, help='Page size for SQLite DB (default: 2**16)')
@click.option('--s3-url', help=f'Upload to this S3 URL (default: `{S3_PREFIX}/<type>.db')
@click.option('-S', '--no-s3', is_flag=True, help='Do not upload to S3')
@types_opt
@click.argument('path', required=False)
def main(input_pqt, n_jobs, replace, page_size: int, s3_url: Optional[str], no_s3: bool, types: list[Type], path):
    kwargs = dict(
        input_pqt=input_pqt,
        path=path,
        replace=replace,
        page_size=page_size,
        s3_url=s3_url,
        no_s3=no_s3,
    )
    if len(types) > 1 and n_jobs != 1:
        if not n_jobs:
            n_jobs = cpu_count()
        from joblib import Parallel, delayed
        Parallel(n_jobs=n_jobs)(delayed(run_type)(tpe, **kwargs) for tpe in types)
    else:
        for tpe in types:
            run_type(tpe, **kwargs)


if __name__ == '__main__':
    main()
