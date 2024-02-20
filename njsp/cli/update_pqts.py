# # Parse/Clean NJSP Fatal Crash XMLs
# - Load XMLs
# - Clean / Assign some dtypes
# - Write to parquet and SQLite
from os import remove
from os.path import exists

import click
import json

from dateutil.parser import parse
from glob import glob

import pandas as pd
from typing import Optional, Tuple

from git import Tree
from utz import sxs

from nj_crashes.fauqstats import FAUQStats
from nj_crashes.utils import s3
from nj_crashes.utils.log import Log, err
from njsp.paths import RUNDATE_PATH, NJSP_DATA
from .base import command
from ..paths import CRASHES_PQT


def get_crashes_df(
        tree: Optional[Tree] = None,
        log: Log = err,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp]:
    if tree is None:
        fauqstatss = [
            FAUQStats.load(path)
            for path in glob('data/FAUQStats20*.xml')
        ]
    else:
        fauqstatss = [
            FAUQStats.load(blob.data_stream, log=log)
            for blob in FAUQStats.blobs(tree).values()
        ]
    fauqstatss = list(sorted(fauqstatss, key=lambda fauqstats: fauqstats.year))
    crashes, totals = [
        pd.concat(dfs)
        for dfs in
        zip(*[
            [ fauqstats.crashes, fauqstats.totals ]
            for fauqstats in fauqstatss
        ])
    ]
    totals = totals.set_index('year').sort_index()
    log(totals)
    log(crashes)

    last_fauqstats = fauqstatss[-1]
    last_year_rundate = last_fauqstats.rundate
    last_year_run_dt = parse(last_year_rundate)
    rundate = pd.to_datetime(last_year_run_dt)

    return crashes, totals, rundate


@command
@click.option('--replace-db', is_flag=True, help="Replace DB tables (instead of rm'ing DB and writing new tables from scratch)")
@click.option('--s3', 'sync_s3', is_flag=True, help=f"Upload to S3 ()")
def update_pqts(replace_db, sync_s3):
    crashes, totals, rundate = get_crashes_df()

    with open(RUNDATE_PATH, 'w') as f:
        json.dump({ 'rundate': str(rundate), }, f)

    counties = (
        crashes
        [['CCODE', 'CNAME']]
        .value_counts()
        .rename('accidents')
        .reset_index()
        .set_index('CCODE')
        .sort_index()
        .CNAME
    )

    munis = (
        crashes
        .groupby('MCODE')
        .apply(
            lambda df: (
                df
                [['MNAME', 'CCODE']]
                .drop_duplicates()
                .set_index('MNAME', drop=True)
            )
        )
        .reset_index(1)
        .sort_index()
    )
    print(munis)

    counties.to_frame().to_parquet(f'{NJSP_DATA}/counties.parquet')
    munis.to_parquet(f'{NJSP_DATA}/munis.parquet')

    muni_counties = (
        crashes
        .groupby('MNAME')
        .apply(lambda df: df['CNAME'].unique())
        .rename('counties')
    )

    muni_county_counts = muni_counties.apply(len).rename('muni_county_counts').sort_values()
    multi_county_counts = muni_county_counts[muni_county_counts > 1]

    print(
        crashes
        .groupby(['CNAME', 'MNAME'])
        .size()
        .rename('accidents')
        .reset_index()
        .merge(
            multi_county_counts,
            left_on='MNAME',
            right_index=True,
        )
        .set_index(['MNAME', 'CNAME'])
        .accidents
    )

    # Verify the reported "total deaths" stat reflects what we see in the crash records
    njsp_totals = totals.fatalities.rename('NJSP total')
    fatalities_per_year = crashes.FATALITIES.groupby(crashes.dt.dt.year).sum().astype(int).rename('NJSP records')
    njsp_diffs = sxs(njsp_totals, fatalities_per_year)[njsp_totals != fatalities_per_year]
    if not njsp_diffs.empty:
        raise RuntimeError(f"NJSP totals don't match crash records:\n{njsp_diffs}")

    # ### Save to file

    from njsp.paths import CRASHES_DB, CRASHES_DB_URI
    from sqlalchemy import create_engine

    if exists(CRASHES_DB) and not replace_db:
        err(f"Removing existing DB {CRASHES_DB}")
        remove(CRASHES_DB)

    engine = create_engine(CRASHES_DB_URI)

    tables = {
        'totals': totals,
        'crashes': crashes,
    }

    replace_kwargs = dict(if_exists='replace') if replace_db else {}
    for name, table in tables.items():
        table.to_sql(name, con=engine, **replace_kwargs)
        table.to_parquet(CRASHES_PQT)

    if sync_s3:
        from njsp.paths import S3_DATA
        s3.upload(CRASHES_PQT, f'{S3_DATA}/crashes.parquet')
        s3.upload(CRASHES_DB, f'{S3_DATA}/crashes.db')

    return "Update NJSP data"
