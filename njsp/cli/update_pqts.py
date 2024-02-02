# # Parse/Clean NJSP Fatal Crash XMLs
# - Load XMLs
# - Clean / Assign some dtypes
# - Write to parquet and SQLite

from utz import *

from nj_crashes.paths import RUNDATE_PATH
from nj_crashes.utils import parse_file
from .base import command
from ..paths import CRASHES_PQT


@command
def update_pqts():
    cur_month = to_dt(now().strftime('%Y-%m'))
    cur_year = cur_month.year

    parsed_files = {
        year: parse_file(f'data/FAUQStats{year}.xml')
        for year in range(2008, cur_year + 1)
    }
    crashes, totals = [
        pd.concat(dfs)
        for dfs in
        zip(*[
            [ dfs['crashes'], dfs['totals'] ]
            for dfs in parsed_files.values()
        ])
    ]
    totals = totals.set_index('year')
    print(totals)

    rundate = to_dt(parsed_files[cur_year]['rundate'])
    with open(RUNDATE_PATH, 'w') as f:
        json.dump({ 'rundate': str(rundate), }, f)

    cur_year_dt = to_dt(str(cur_year)).tz_localize(rundate.tz)
    nxt_year_dt = to_dt(str(cur_year + 1)).tz_localize(rundate.tz)
    cur_month_dt = cur_month.tz_localize(rundate.tz)

    print(cur_year_dt, cur_month_dt, rundate, nxt_year_dt)

    crashes['dt'] = crashes[['DATE', 'TIME']].apply(lambda r: to_dt(f'{r["DATE"]} {r["TIME"]}'), axis=1)
    crashes = (
        crashes
        .astype({
            'FATALITIES': float,
            'FATAL_D': float,
            'FATAL_P': float,
            'FATAL_T': float,
            'FATAL_B': float,
            'INJURIES': float,
        })
        .drop(columns=['DATE', 'TIME'])
        .set_index('ACCID')
    )
    crashes = crashes.sort_values('dt')
    print(crashes)

    counties = crashes[['CCODE', 'CNAME']].value_counts().rename('accidents').reset_index().set_index('CCODE').sort_index().CNAME

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

    counties.to_frame().to_parquet('data/counties.pqt')
    munis.to_parquet('data/munis.pqt')

    muni_counties = crashes.groupby('MNAME').apply(lambda df: df['CNAME'].unique()).rename('counties')

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

    # ### Save to file

    from nj_crashes.paths import DB_URI
    from sqlalchemy import create_engine

    engine = create_engine(DB_URI)

    tables = {
        'totals': totals,
        'crashes': crashes,
    }

    for name, table in tables.items():
        table.to_sql(name, con=engine, if_exists='replace')
        table.to_parquet(CRASHES_PQT)

    return "Update NJSP data"
