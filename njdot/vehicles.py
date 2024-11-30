#!/usr/bin/env python

import click
import pandas as pd
from typing import Optional

from nj_crashes.utils.log import err
from njdot import crashes
from njdot.load import Years, load_tbl, pk_base, normalize
from njdot.rawdata import years_opt

renames = {
    'Year': 'year',
    'Vehicle Number': 'vn',
    'Color of Vehicle': 'color',
    'Make of Vehicle': 'make',
    'Model of Vehicle': 'model',
    'Year of Vehicle': 'vy',
    'Owner State': 'owner_state',
    'License Plate State': 'state',
    'Vehicle Type': 'type',
    'Vehicle Use': 'use',
    'Contributing Circumstances 1': 'cir1',
    'Contributing Circumstances 2': 'cir2',
    'Direction of Travel': 'dir',
    'Pre-Crash Action': 'act',
    'First Sequence of Events': 'ev1',
    'Second Sequence of Events': 'ev2',
    'Third Sequence of Events': 'ev3',
    'Fourth Sequence of Events': 'ev4',
    'Hit & Run Driver Flag': 'hit_run',
    'Extent of Damage': 'damage',
    'Most Harmful Event': 'ev',  # added in 2017
    'Towed': 'towed',  # removed in 2017, folded into `departure` below
    'Removed By': 'rm_by',
    'Initial Impact Location': 'impact_loc',
    'Principal Damage Location': 'damage_loc',
    'Driven/Left at Scene/Towed': 'departure',
    'Oversize/Overweight Permit': 'oversize',
    'Cargo Body Type': 'cargo_type',
    'Insurance Company Code': 'ins_co',
}

astype = {
    'vn': 'int8',
    'vy': 'Int16',
    'ins_co': 'Int16',
    **{ k: 'Int8' for k in [
        'type',
        'cir1',
        'cir2',
        'dir',
        'act',
        'ev1',
        'ev2',
        'ev3',
        'ev4',
        'damage',
        'ev',
        'rm_by',
        'impact_loc',
        'damage_loc',
        'oversize',
        'cargo_type',
    ]},
}

pk_cols = pk_base + ['vn']


def map_towed_to_departure(r: pd.Series) -> int:
    towed = r.towed
    departure = r.departure
    if towed == 'T':
        return 6
    if towed == 'L':
        return 2
    if towed == 'D':
        return 1
    if towed == '?' or towed == '':
        if departure == '':
            return 0
        else:
            return int(departure)
    raise ValueError(f"Unrecognized `towed` value: {r['towed']}")


def map_year_df(df: pd.DataFrame) -> pd.DataFrame:
    # Columns beginning with capital letters are inherited from the original data source; the ones we care about are
    # listed in `renames` above.
    df = df[df.columns[~df.columns.str.match(r'^[A-Z]')]].copy()
    if 'departure' not in df:
        df['departure'] = ''
    df['departure'] = df[['towed', 'departure']].apply(map_towed_to_departure, axis=1).astype('Int8')
    df = df.drop(columns='towed')
    return df


def map_df(v: pd.DataFrame) -> pd.DataFrame:
    err("Merging vehicles with crashes")
    left_on = pk_base
    right_on = [ 'mc_dot' if c == 'mc' else c for c in pk_base ]
    v = normalize(v, 'crash_id', crashes.load)
    v.index = v.index.astype('int32')
    return v


def load(
    years: Years = None,
    county: str = None,
    read_pqt: Optional[bool] = None,
    write_pqt: bool = False,
    pqt_path: Optional[str] = None,
    n_jobs: int = 0,
    cols: Optional[list[str]] = None,
) -> pd.DataFrame:
    df = load_tbl(
        'vehicles',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=map_df,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        pqt_path=pqt_path,
        n_jobs=n_jobs,
    )
    return df


@click.command()
@years_opt
@click.argument('path', required=False)
def main(years, path):
    load(
        years=years,
        write_pqt=True,
        pqt_path=path,
    )


if __name__ == '__main__':
    main()
