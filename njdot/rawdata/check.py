import pandas as pd
import sys
from click import option
from utz import err

from njdot.paths import DOT_DATA
from njdot.data import COUNTIES, YEARS
from .base import rawdata


@rawdata.command('check-nj-agg', short_help='For one or more years, verify the `NewJersey` file is a concatenation of the county-specific files')
@option('-y', '--year', 'years')
def check_nj_agg(years):
    years = map(int, years.split(',')) if years else YEARS
    for year in years:
        nj = pd.read_parquet(f'{DOT_DATA}/{year}/NewJersey{year}Accidents.pqt')
        cs = pd.concat([
            pd.read_parquet(f'{year}/{county}{year}Accidents.pqt')
            for county in COUNTIES
        ])

        errors = []
        def error(msg):
            nonlocal errors
            err(f'{year}: {msg}')
            errors.append(msg)

        if len(nj) != len(cs):
            error(f'{len(nj)} NJ, {len(cs)} counties')
        combined = pd.concat([ nj, cs ])

        nj_cs_isdup = combined.duplicated(keep='first')
        nj_cs_isdup1, nj_cs_isdup2 = nj_cs_isdup.iloc[:len(nj)], nj_cs_isdup.iloc[len(nj):]
        if nj_cs_isdup1.any():
            intra_nj_dups = nj[nj_cs_isdup1]
            error(f'{len(intra_nj_dups)} intra-NJ dupes:\n{intra_nj_dups}')
        if not nj_cs_isdup2.all():
            cs_only = cs[~nj_cs_isdup2]
            error(f'{len(cs_only)} counties-only rows:\n{cs_only}')

        cs_nj_isdup = combined.duplicated(keep='last')
        cs_nj_isdup1, cs_nj_isdup2 = cs_nj_isdup.iloc[:len(nj)], cs_nj_isdup.iloc[len(nj):]
        if cs_nj_isdup2.any():
            intra_cs_dups = cs[cs_nj_isdup2]
            error(f'{len(intra_cs_dups)} intra-county dupes:\n{intra_cs_dups}')
        if not cs_nj_isdup1.all():
            nj_only = nj[~cs_nj_isdup1]
            error(f'{len(nj_only)} NJ-only rows:\n{nj_only}')

        if errors:
            sys.exit(1)
        else:
            print(f'{year}: {len(nj)} NJ records match {len(cs)} county-level records')
