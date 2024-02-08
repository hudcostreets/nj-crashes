# # Parse/Clean NJSP Fatal Crash XMLs
# - Load XMLs
# - Clean / Assign some dtypes
# - Write to parquet and SQLite
from git import Tree
from utz import *

from nj_crashes.paths import RUNDATE_PATH
from nj_crashes.utils import parse_file, Log
from .base import command
from ..paths import CRASHES_PQT


def get_crashes_df(tree: Optional[Tree] = None, log: Log = err) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp]:
    if tree is None:
        parsed_files = [
            parse_file(path)
            for path in glob('data/FAUQStats20*.xml')
        ]
    else:
        data = tree['data']
        blobs = data.blobs
        parsed_files = [
            parse_file(blob.data_stream, log=log, blob_sha=blob.hexsha)
            for blob in blobs
            if blob.name.startswith('FAUQStats20')
        ]
    crashes, totals = [
        pd.concat(dfs)
        for dfs in
        zip(*[
            [ dfs['crashes'], dfs['totals'] ]
            for dfs in parsed_files
        ])
    ]
    totals = totals.set_index('year')
    log(totals)

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
    log(crashes)

    last_parsed_file = parsed_files[-1]
    last_year_rundate = last_parsed_file['rundate']
    # err(last_year_rundate)
    last_year_run_dt = parse(last_year_rundate)
    # err(str(last_year_run_dt))
    rundate = to_dt(last_year_run_dt)

    return crashes, totals, rundate


@command
def update_pqts():
    crashes, totals, rundate = get_crashes_df()

    with open(RUNDATE_PATH, 'w') as f:
        json.dump({ 'rundate': str(rundate), }, f)

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

    # Verify the reported "total deaths" stat reflects what we see in the crash records
    njsp_totals = totals.fatalities.rename('NJSP total')
    fatalities_per_year = crashes.FATALITIES.groupby(crashes.dt.dt.year).sum().astype(int).rename('NJSP records')
    njsp_diffs = sxs(njsp_totals, fatalities_per_year)[njsp_totals != fatalities_per_year]
    if not njsp_diffs.empty:
        raise RuntimeError(f"NJSP totals don't match crash records:\n{njsp_diffs}")

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
