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


def map_towed_to_departure(r: pd.Series) -> Optional[int]:
    import pandas as pd
    from numpy import nan
    towed = r.towed
    departure = r.departure
    if towed == 'T':
        return 6
    if towed == 'L':
        return 2
    if towed == 'D':
        return 1
    if towed == '?' or towed == '' or pd.isna(towed):
        if departure == '' or pd.isna(departure):
            return 0
        else:
            # Handle invalid values like 'UNK'
            try:
                return int(departure)
            except (ValueError, TypeError):
                return nan  # Return NaN for invalid values
    raise ValueError(f"Unrecognized `towed` value: {r['towed']}")


def map_year_df(df: pd.DataFrame) -> pd.DataFrame:
    import os
    from numpy import nan
    # Columns beginning with capital letters are inherited from the original data source; the ones we care about are
    # listed in `renames` above.
    df = df[df.columns[~df.columns.str.match(r'^[A-Z]')]].copy()

    # Clean invalid values ('UNK', '?', etc.) from coded fields before type conversion
    # Replace with empty string which will become NaN during Int8/Int16 conversion
    for col in df.columns:
        if df[col].dtype == 'object':
            # Strip whitespace first, then replace invalid values
            df[col] = df[col].astype(str).str.strip()
            df[col] = df[col].replace([' UNK', 'UNK', '?', 'UNKNOWN', 'nan'], '')

    if 'departure' not in df:
        df['departure'] = ''
    # Convert towed/departure to departure code, using nullable Int8
    df['departure'] = df[['towed', 'departure']].apply(map_towed_to_departure, axis=1).astype(pd.Int8Dtype())
    df = df.drop(columns='towed')

    # Fix 2023 data quality issues: duplicate vehicle keys
    # Note: vn is a foreign key referenced by occupants/drivers, so we can't renumber it
    #
    # Strategy (2023 only):
    # - Use smart merge: keep vehicles from TCASE crashes (geocoded/updated version)
    # - This works because vehicles inherit their "version" from their parent crash
    # - Achieves ~75% intelligent merges vs arbitrary "keep first"
    #
    # For other years: simple deduplication (shouldn't have duplicates)
    crash_key = ['year', 'cc', 'mc', 'case']
    vehicle_key = crash_key + ['vn']

    before = len(df)

    # Check if we have duplicates
    dupe_mask = df.duplicated(vehicle_key, keep=False)
    if not dupe_mask.any():
        return df

    year = df['year'].iloc[0]

    # Optionally write duplicate side-outputs for analysis
    write_dupe_outputs = os.environ.get('NJDOT_WRITE_DUPE_OUTPUTS', '').lower() in ('1', 'true', 'yes')
    if write_dupe_outputs:
        from njdot.dupe_utils import analyze_and_write_dupes
        # Need to use original column names for side-outputs
        df_with_orig_cols = df.copy()
        df_with_orig_cols['County Code'] = df_with_orig_cols['cc']
        df_with_orig_cols['Municipality Code'] = df_with_orig_cols['mc']
        df_with_orig_cols['Department Case Number'] = df_with_orig_cols['case']
        df_with_orig_cols['Vehicle Number'] = df_with_orig_cols['vn']
        pk_orig = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number']
        analyze_and_write_dupes(df_with_orig_cols, pk_orig, 'vehicles', year, write_outputs=True)

    # Use smart merge for 2023 (keep vehicles from TCASE crashes)
    if year == 2023:
        from njdot.merge_vo_dupes import merge_vo_duplicates

        # merge_vo_duplicates expects original column names + _orig_lineno
        # Rename columns back to original names for merge
        df = df.rename(columns={
            'cc': 'County Code',
            'mc': 'Municipality Code',
            'case': 'Department Case Number',
            'vn': 'Vehicle Number',
        })
        pk_orig = ['County Code', 'Municipality Code', 'Department Case Number', 'Vehicle Number']

        df = merge_vo_duplicates(df, pk_orig, 'vehicles', year)

        # Rename back to internal names
        df = df.rename(columns={
            'County Code': 'cc',
            'Municipality Code': 'mc',
            'Department Case Number': 'case',
            'Vehicle Number': 'vn',
        })
        df = df.drop(columns=['_orig_lineno'], errors='ignore')
    else:
        # Simple deduplication for other years (shouldn't have duplicates)
        df_deduped = df.drop_duplicates(keep='first')
        df = df_deduped.drop_duplicates(subset=vehicle_key, keep='first')

        num_dropped = before - len(df)
        if num_dropped > 0:
            err(f"Dropped {num_dropped:,} duplicate vehicle records (year {year})")

    return df


def map_df(v: pd.DataFrame) -> pd.DataFrame:
    # Fix vehicle cc/mc using PK mapping table
    # Crashes undergo geocoding (Port Authority, empty municipality fixes) that updates cc/mc,
    # but vehicles retain original cc/mc from raw data
    # Mapping table: (year, cc0, mc0, case) → (cc, mc) tracks all PK transformations
    from njdot.paths import DOT_DATA
    import os

    mapping_path = f'{DOT_DATA}/crash_pk_mappings.parquet'
    if os.path.exists(mapping_path):
        err("Fixing vehicle cc/mc using PK mapping table")
        mapping = pd.read_parquet(mapping_path)

        # Merge on (year, cc, mc, case) to get updated cc/mc
        # Note: vehicles have original cc/mc, which match mapping's cc0/mc0
        v_with_mapping = v.merge(
            mapping[['year', 'cc0', 'mc0', 'case', 'cc', 'mc']],
            left_on=['year', 'cc', 'mc', 'case'],
            right_on=['year', 'cc0', 'mc0', 'case'],
            how='left',
            suffixes=('_old', '')
        )

        # Update cc/mc where mapping exists
        # For rows without mapping, cc/mc will be NaN, so fill with original values
        # Note: mc may be float64 (combined codes like 9901.0 for Port Authority)
        v['cc'] = v_with_mapping['cc'].fillna(v['cc']).astype('int8')
        # Convert mc to float to handle combined codes from crashes
        v['mc'] = v_with_mapping['mc'].fillna(v['mc'].astype('float64'))

        num_updated = v_with_mapping['cc'].notna().sum()
        err(f"  Updated {num_updated:,} vehicle PKs from mapping table")
    else:
        err(f"Warning: PK mapping table not found at {mapping_path}, skipping cc/mc fix")

    err("Merging vehicles with crashes")
    left_on = pk_base
    right_on = [ 'mc_dot' if c == 'mc' else c for c in pk_base ]
    v = normalize(v, 'crash_id', crashes.load)
    v.index = v.index.astype('int32')

    # Drop any remaining orphaned vehicles (couldn't match to crash)
    orphans = v['crash_id'].isna()
    if orphans.any():
        num_orphans = orphans.sum()
        err(f"Dropping {num_orphans} orphaned vehicles (couldn't match to crash)")
        v = v[~orphans].copy()

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
