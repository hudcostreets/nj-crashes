# # Parse/Clean NJSP Fatal Crash XMLs
# - Load XMLs
# - Clean / Assign some dtypes
# - Write to parquet and SQLite
import sqlite3
from os import remove
from os.path import exists

import click
import json

from glob import glob

import pandas as pd
from typing import Optional, Tuple

from git import Tree
from utz import sxs

from nj_crashes.muni_codes import update_mc
from nj_crashes.paths import DATA_DIR, COUNTY_CITY_CODES_PQT
from nj_crashes.utils import s3, sql
from nj_crashes.utils.log import Log, err
from njsp.fauqstats import FAUQStats
from njsp.paths import RUNDATE_PATH, CRASHES_PQT_S3, CRASHES_DB_S3
from njsp.utils import parse_rundate
from .base import command
from ..paths import CRASHES_PQT


def get_crashes_df(
        tree: Optional[Tree] = None,
        log: Log = err,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp]:
    if tree is None:
        fauqstatss = [
            FAUQStats.load(path)
            for path in glob(f'{DATA_DIR}/FAUQStats20*.xml')
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
    last_year_run_dt = parse_rundate(last_year_rundate)
    rundate = pd.to_datetime(last_year_run_dt)

    return crashes, totals, rundate


@command
@click.option('--replace-db', is_flag=True, help="Replace DB tables (instead of rm'ing DB and writing new tables from scratch)")
@click.option('--s3', 'sync_s3', is_flag=True, help=f"Upload to S3")
def update_pqts(replace_db, sync_s3):
    """Update crashes Parquet/SQLite with NJSP crash data, update rundate.json."""
    crashes, totals, rundate = get_crashes_df()
    crashes['cc'] = crashes.CCODE.astype(int)
    crashes['mc_sp'] = crashes.MCODE.str[2:].astype(int)
    crashes.index.name = 'id'
    crashes.index = crashes.index.astype('int16')
    assert not crashes.mc_sp.isna().any()
    crashes = (
        update_mc(crashes, 'sp')
        .drop(columns=[ 'CCODE', 'CNAME', 'MCODE', 'MNAME', ])
        .sort_values('dt')
        .rename(columns={
            'FATALITIES': 'tk',
            'INJURIES': 'ti',
            'FATAL_D': 'dk',
            'FATAL_P': 'ok',
            'FATAL_T': 'pk',
            'FATAL_B': 'bk',
            **{
                c: c.lower()
                for c in [ 'STREET', 'HIGHWAY', 'LOCATION', ]
            }
        })
        [[ 'cc', 'mc', 'dt', 'tk', 'ti', 'dk', 'ok', 'pk', 'bk', 'location', 'street', 'highway', ]]
        .astype({
            'cc': 'int8',
            'mc': 'int8',
            **{ c: 'Int8' for c in [ 'tk', 'ti', 'dk', 'ok', 'pk', 'bk', ] },
        })
    )

    with open(RUNDATE_PATH, 'w') as f:
        json.dump({ 'rundate': str(rundate), }, f)

    # Verify the reported "total deaths" stat reflects what we see in the crash records
    njsp_totals = totals.fatalities.rename('NJSP total')
    fatalities_per_year = crashes.tk.groupby(crashes.dt.dt.year).sum().astype(int).rename('NJSP records')
    njsp_diffs = sxs(njsp_totals, fatalities_per_year)[njsp_totals != fatalities_per_year]
    if not njsp_diffs.empty:
        raise RuntimeError(f"NJSP totals don't match crash records:\n{njsp_diffs}")

    # ### Save to file

    from njsp.paths import CRASHES_DB, CRASHES_DB_URI

    if exists(CRASHES_DB) and not replace_db:
        err(f"Removing existing DB {CRASHES_DB}")
        remove(CRASHES_DB)

    replace_kwargs = dict(if_exists='replace') if replace_db else {}
    crashes.to_sql('crashes', CRASHES_DB_URI, **replace_kwargs)
    crashes.to_parquet(CRASHES_PQT)

    with sqlite3.connect(CRASHES_DB) as con:
        cur = con.cursor()
        sql.add_idx(cur, 'crashes', 'dt')
        sql.add_idx(cur, 'crashes', 'cc', 'mc', 'dt')

    if sync_s3:
        s3.upload(CRASHES_PQT, CRASHES_PQT_S3)
        s3.upload(CRASHES_DB, CRASHES_DB_S3)

    return "Update NJSP data"
