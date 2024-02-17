import pandas as pd
from typing import Optional
from utz import sxs

from njdot import crashes
from njdot.load import Years, load_type, pk_base

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
    'Contributing Circumstances 1': 'cir1',
    'Contributing Circumstances 2': 'cir2',
    'Direction of Travel': 'dir',
    'Pre-Crash Action': 'act',
    'First Sequence of Events': 'ev1',
    'Second Sequence of Events': 'ev2',
    'Third Sequence of Events': 'ev3',
    'Fourth Sequence of Events': 'ev4',
    'Hit & Run Driver Flag': 'hit_run',
    'Extent of Damage': 'dmg',
    'Most Harmful Event': 'ev',
    'Towed': 'towed',
    'Removed By': 'rm_by',
    'Initial Impact Location': 'imp_loc',
    'Principal Damage Location': 'dmg_loc',
    'Driven/Left at Scene/Towed': 'dep',
    'Oversize/Overweight Permit': 'oversize',
    'Cargo Body Type': 'body',
    'Insurance Company Code': 'ins_co',
}

astype = {
    'vn': int,
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
        'dmg',
        'ev',
        'rm_by',
        'imp_loc',
        'dmg_loc',
        'oversize',
        'body',
    ]},
}


def map_year_df(df: pd.DataFrame) -> pd.DataFrame:
    df = df[df.columns[~df.columns.str.match(r'^[A-Z]')]]
    return df


def map_df(v: pd.DataFrame) -> pd.DataFrame:
    c = crashes.load(cols=pk_base + ['tv'])
    vb = v[pk_base + ['vn']]
    m = vb.merge(
        c[pk_base].reset_index().rename(columns={'id': 'crash_id'}),
        on=pk_base,
        how='left',
        validate='m:1',
    )
    vm = sxs(m.crash_id, v.drop(columns=pk_base))
    return vm


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        cols: Optional[list[str]] = None,
):
    df = load_type(
        'Vehicles',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        map_year_df=map_year_df,
        map_df=map_df,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
    )
    return df
