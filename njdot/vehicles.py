import pandas as pd
from typing import Optional

from nj_crashes.utils.log import err
from njdot import crashes
from njdot.load import Years, load_type, pk_base, normalize

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
        'dmg',
        'ev',
        'rm_by',
        'imp_loc',
        'dmg_loc',
        'oversize',
        'body',
    ]},
}

pk_cols = pk_base + ['vn']


def map_year_df(df: pd.DataFrame) -> pd.DataFrame:
    # Columns beginning with capital letters are inherited from the original data source; the ones we care about are
    # listed in `renames` above.
    df = df[df.columns[~df.columns.str.match(r'^[A-Z]')]]
    return df


def map_df(v: pd.DataFrame) -> pd.DataFrame:
    err("Merging vehicles with crashes")
    v = normalize(v, pk_base, 'crash_id', crashes.load)
    v.index = v.index.astype('int32')
    return v


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        cols: Optional[list[str]] = None,
) -> pd.DataFrame:
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
