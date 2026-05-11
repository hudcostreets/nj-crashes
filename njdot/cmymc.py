#!/usr/bin/env python
"""Port of `njdot/cmymc.ipynb` — builds the `cmymc.db` SQLite of
{County, Muni, Year, Month} × {condition × type} aggregations consumed
by the worker's `/api/year-stats` endpoint.

Two data legs are loaded and concat'd at the (cc, mc, y, m, condition,
type) grouping level:

  - Legacy (2001-2022) — master crashes/occupants/pedestrians/vehicles
    parquets joined via `crash_id` row-index.
  - AASHTO (2023-2025) — `aashto_supplemented_crashes.parquet` +
    `aashto_supplemented_{occupants,pedestrians}.parquet` joined via
    `(year, cc, mc, case)` PK. 2023 here supersedes the legacy 2023.

Vehicles supplement isn't built yet (no AASHTO adapter for vehicle
disposition/damage fields), so the `cmymv*` tables remain legacy-only
for now.
"""
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd
from numpy import nan
from utz import sxs

from nj_crashes.utils import sql
from njdot import crashes, occupants, pedestrians, vehicles
from njdot.paths import CMYMC_DB

err = partial(print, file=sys.stderr)

CMYM_COLS = ['cc', 'mc', 'y', 'm']
CMYMTC_COLS = CMYM_COLS + ['condition', 'type']
AASHTO_YEARS = [2023, 2024, 2025]


def add_y_m(df: pd.DataFrame) -> pd.DataFrame:
    """Add `y` (year) and `m` (month) columns derived from `dt`/`year`."""
    df = df.copy()
    df['y'] = df['year'] if 'year' in df else df['dt'].dt.year
    df['m'] = df['dt'].dt.month.astype('Int8')
    return df


def load_legacy_crashes(drop_years: list[int]) -> pd.DataFrame:
    """Load master crashes, drop years that are AASHTO-superseded."""
    err('Loading legacy crashes (master parquet)…')
    c = crashes.load(cols=['dt', 'year', 'cc', 'mc', 'case', 'severity', 'tk', 'ti', 'pk', 'pi'])
    c = c[~c['year'].isin(drop_years)]
    c = add_y_m(c)
    err(f'  {len(c):,} legacy crashes after dropping years {drop_years}')
    return c


def load_legacy_persons_legs(c_legacy: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load legacy occupants/pedestrians, join via `crash_id`, return
    DFs with (cc, mc, y, m, condition, type) ready to aggregate."""
    err('Loading legacy occupants…')
    o = occupants.load()
    om = o.merge(c_legacy[['cc', 'mc', 'y', 'm']], left_on='crash_id', right_index=True, how='inner', validate='m:1')
    om = om[(om.condition >= 1) & (om.condition <= 5)]
    om['type'] = pd.Series(pd.NA, index=om.index, dtype='string')
    om.loc[om.pos == 1, 'type'] = 'd'
    om.loc[om.pos > 1, 'type'] = 'o'
    om = om[~om.type.isna()]
    err(f'  {len(om):,} legacy occupant rows kept')

    err('Loading legacy pedestrians…')
    p = pedestrians.load()
    pm = p.merge(c_legacy[['cc', 'mc', 'y', 'm']], left_on='crash_id', right_index=True, how='inner', validate='m:1')
    pm = pm[(pm.condition >= 1) & (pm.condition <= 5)]
    pm['type'] = pd.Series(pd.NA, index=pm.index, dtype='string')
    pm.loc[ pm.cyclist, 'type'] = 'b'
    pm.loc[~pm.cyclist, 'type'] = 't'
    err(f'  {len(pm):,} legacy pedestrian rows kept')
    return om, pm


def load_aashto_legs(c_aashto: pd.DataFrame,
                     occupants_path: Path,
                     pedestrians_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load 2023+ supplements, merge with aashto_supplemented_crashes."""
    err(f'Loading AASHTO occupants supplement from {occupants_path}…')
    o = pd.read_parquet(occupants_path)
    om = o.merge(c_aashto[['year', 'cc', 'mc', 'case', 'y', 'm']],
                 on=['year', 'cc', 'mc', 'case'], how='inner', validate='m:1')
    om = om[(om.condition >= 1) & (om.condition <= 5)]
    om['type'] = pd.Series(pd.NA, index=om.index, dtype='string')
    om.loc[om.pos == 1, 'type'] = 'd'
    om.loc[om.pos > 1, 'type'] = 'o'
    om = om[~om.type.isna()]
    err(f'  {len(om):,} AASHTO occupant rows kept')

    err(f'Loading AASHTO pedestrians supplement from {pedestrians_path}…')
    p = pd.read_parquet(pedestrians_path)
    pm = p.merge(c_aashto[['year', 'cc', 'mc', 'case', 'y', 'm']],
                 on=['year', 'cc', 'mc', 'case'], how='inner', validate='m:1')
    pm = pm[(pm.condition >= 1) & (pm.condition <= 5)]
    pm['type'] = pd.Series(pd.NA, index=pm.index, dtype='string')
    pm.loc[ pm.cyclist, 'type'] = 'b'
    pm.loc[~pm.cyclist, 'type'] = 't'
    err(f'  {len(pm):,} AASHTO pedestrian rows kept')
    return om, pm


def build_cmymc(om: pd.DataFrame, pm: pd.DataFrame,
                c_combined: pd.DataFrame) -> pd.DataFrame:
    """Build the cmymc table: {drivers, passengers, pedestrians, cyclists,
    num_crashes} by (cc, mc, y, m, condition)."""
    err('Aggregating per-victim counts…')
    pg = pm.groupby(CMYMTC_COLS).size().rename('num')
    og = om.groupby(CMYMTC_COLS).size().rename('num')
    g = pd.concat([pg, og]).sort_index()

    err('Computing per-crash severity (min over occupants + pedestrians per crash)…')
    # min condition = worst severity. Per-crash 'condition' is min of any
    # involved occupant or pedestrian. Legacy keyed by crash_id; AASHTO
    # keyed by (year, cc, mc, case). Compute separately, then union.

    def per_crash_severity(legacy_df, aashto_df, key_legacy, key_pk):
        legacy_part = (
            legacy_df[legacy_df['crash_id'].notna() if 'crash_id' in legacy_df.columns else slice(None)]
            .groupby(key_legacy)['condition'].min()
            if 'crash_id' in legacy_df.columns else pd.Series(dtype='int8')
        )
        return legacy_part

    # Distinguish legacy (has `crash_id` col) from AASHTO (has `case`)
    om_legacy = om[om.get('crash_id').notna()] if 'crash_id' in om else om.iloc[:0]
    pm_legacy = pm[pm.get('crash_id').notna()] if 'crash_id' in pm else pm.iloc[:0]
    om_aashto = om[om.get('case').notna()] if 'case' in om else om.iloc[:0]
    pm_aashto = pm[pm.get('case').notna()] if 'case' in pm else pm.iloc[:0]

    # Per-crash min-condition for legacy (keyed by crash_id)
    sev_legacy_o = om_legacy.groupby('crash_id')['condition'].min().rename('occ_sev') if len(om_legacy) else pd.Series(dtype='Int8', name='occ_sev')
    sev_legacy_p = pm_legacy.groupby('crash_id')['condition'].min().rename('ped_sev') if len(pm_legacy) else pd.Series(dtype='Int8', name='ped_sev')
    if len(sev_legacy_o) or len(sev_legacy_p):
        sev_legacy = sxs(sev_legacy_o, sev_legacy_p).min(axis=1).rename('condition')
        c_leg = c_combined[c_combined.index.notna() & (~c_combined['year'].isin(AASHTO_YEARS))]
        c_leg_with_sev = c_leg.drop(columns=['severity']).join(sev_legacy, how='left')
        c_leg_with_sev['condition'] = c_leg_with_sev['condition'].fillna(5).astype('int8')
    else:
        c_leg_with_sev = pd.DataFrame(columns=list(c_combined.columns) + ['condition'])

    # Per-crash min-condition for AASHTO (keyed by year/cc/mc/case).
    # AASHTO 2024+ person-level severity undercounts ped/cyclist fatals
    # (see `to_njdot_persons.py` ghost-Driver docs). Override with
    # crash-level `severity` when more severe: f→1, i→ keep min(person, 4).
    if len(om_aashto) or len(pm_aashto):
        pk = ['year', 'cc', 'mc', 'case']
        sev_a_o = om_aashto.groupby(pk)['condition'].min().rename('occ_sev')
        sev_a_p = pm_aashto.groupby(pk)['condition'].min().rename('ped_sev')
        sev_a = sxs(sev_a_o, sev_a_p).min(axis=1).rename('person_cond').reset_index()
        c_a = c_combined[c_combined['year'].isin(AASHTO_YEARS)]
        c_a_with_sev = c_a.merge(sev_a, on=pk, how='left')
        # Crash-level severity → upper bound on condition code:
        # 'f' → 1 (fatal), 'i' → 4 (possible injury, conservative), 'p' → 5
        sev_floor = c_a_with_sev['severity'].map({'f': 1, 'i': 4, 'p': 5}).fillna(5).astype('int8')
        person_cond = c_a_with_sev['person_cond'].fillna(5).astype('int8')
        c_a_with_sev['condition'] = pd.concat([sev_floor, person_cond], axis=1).min(axis=1).astype('int8')
        c_a_with_sev = c_a_with_sev.drop(columns=['severity', 'person_cond'])
    else:
        c_a_with_sev = pd.DataFrame(columns=list(c_combined.columns) + ['condition'])

    cs = pd.concat([c_leg_with_sev, c_a_with_sev], ignore_index=True)
    cxs = cs.groupby(CMYM_COLS + ['condition']).size().rename('num_crashes')

    cmymc = g.reset_index(level=5).pivot(columns='type', values='num')[['d', 'o', 't', 'b']].rename(columns={
        'd': 'drivers',
        'o': 'passengers',
        't': 'pedestrians',
        'b': 'cyclists',
    })
    cmymc = sxs(cmymc, cxs).fillna(0).astype(int)
    err(f'  cmymc shape: {cmymc.shape}')
    return cmymc


def sum_idx_col(df0, col, db_path, tbl_suffix='', page_size=None):
    """Roll up df0 by removing one index level + summing."""
    idx_cols0 = df0.index.names
    idx_cols1 = [c for c in idx_cols0 if c != col]
    assert len(idx_cols1) + 1 == len(idx_cols0)
    df1 = df0.reset_index().drop(columns=col).groupby(idx_cols1).sum()
    tbl = ''.join([c[0] for c in idx_cols1]) + tbl_suffix
    sql.write(
        df1, tbl, db_path,
        idxs=[tuple(idx_cols1)],
        replace=False,
        page_size=page_size,
    )
    return df1


@click.command()
@click.option('-O', '--occupants-supplement', type=click.Path(path_type=Path),
              default=Path('njdot/data/aashto_supplemented_occupants.parquet'))
@click.option('-P', '--pedestrians-supplement', type=click.Path(path_type=Path),
              default=Path('njdot/data/aashto_supplemented_pedestrians.parquet'))
@click.option('-C', '--crashes-supplement', type=click.Path(path_type=Path),
              default=Path('njdot/data/aashto_supplemented_crashes.parquet'))
@click.option('-o', '--out', type=click.Path(path_type=Path), default=Path(CMYMC_DB))
@click.option('-S', '--skip-upload', is_flag=True, help='Skip S3 upload')
def main(occupants_supplement: Path, pedestrians_supplement: Path,
         crashes_supplement: Path, out: Path, skip_upload: bool):
    # Legacy leg
    c_legacy = load_legacy_crashes(drop_years=AASHTO_YEARS)
    om_legacy, pm_legacy = load_legacy_persons_legs(c_legacy)

    # AASHTO leg
    err(f'Loading AASHTO supplemented crashes from {crashes_supplement}…')
    c_aashto = pd.read_parquet(crashes_supplement)
    c_aashto = add_y_m(c_aashto)
    # Dedupe on PK + drop NaN PKs (no lookup) — small fraction, primarily
    # the 248 cc/mc lookup failures and ~3k AASHTO source dupes
    pk = ['year', 'cc', 'mc', 'case']
    n_before = len(c_aashto)
    c_aashto = c_aashto.dropna(subset=['cc', 'mc']).drop_duplicates(pk, keep='first')
    err(f'  {len(c_aashto):,} AASHTO crashes after dedup/dropna ({n_before - len(c_aashto):,} dropped); '
        f'years {sorted(c_aashto.year.unique().tolist())}')
    om_aashto, pm_aashto = load_aashto_legs(c_aashto, occupants_supplement, pedestrians_supplement)

    # Mark each leg for per-crash-severity routing
    om_legacy = om_legacy.reset_index() if om_legacy.index.name == 'id' else om_legacy
    pm_legacy = pm_legacy.reset_index() if pm_legacy.index.name == 'id' else pm_legacy
    om_combined = pd.concat([om_legacy, om_aashto], ignore_index=True, sort=False)
    pm_combined = pd.concat([pm_legacy, pm_aashto], ignore_index=True, sort=False)

    # Cast cc/mc to int (legacy was already int; AASHTO has float64 NaN-aware)
    for df in (om_combined, pm_combined):
        df['cc'] = df['cc'].astype('Int8')
        df['mc'] = df['mc'].astype('Int16')

    # Combined crashes frame for per-crash severity + crash counts
    c_legacy_r = c_legacy.reset_index().rename(columns={'id': 'crash_id'})
    c_combined_cols = ['year', 'cc', 'mc', 'case', 'y', 'm', 'severity', 'tk', 'ti', 'pk', 'pi']
    c_combined = pd.concat([
        c_legacy_r[c_combined_cols],
        c_aashto[c_combined_cols],
    ], ignore_index=True, sort=False)
    c_combined['cc'] = c_combined['cc'].astype('Int8')
    c_combined['mc'] = c_combined['mc'].astype('Int16')

    cmymc = build_cmymc(om_combined, pm_combined, c_combined)

    err(f'\nWriting tables to {out}…')
    sql.write(
        cmymc, 'cmymc', str(out),
        idxs=[('cc', 'mc', 'y', 'm', 'condition')],
        rm=True,
        page_size=2**16,
    )

    cmyc = sum_idx_col(cmymc, 'm', str(out))
    cymc = sum_idx_col(cmymc, 'mc', str(out))
    ymc = sum_idx_col(cymc, 'cc', str(out))
    cyc = sum_idx_col(cymc, 'm', str(out))
    yc = sum_idx_col(cyc, 'cc', str(out))

    # Vehicles leg — legacy only for now (AASHTO has no per-vehicle disposition adapter yet)
    err('Loading legacy vehicles…')
    v = vehicles.load()
    vm = v.merge(c_legacy[['cc', 'mc', 'y', 'm']], left_on='crash_id', right_index=True, how='inner', validate='m:1')
    vm['towed'] = vm.departure >= 3
    vm['disabled'] = (vm.departure == 3) | (vm.departure == 5) | (vm.damage == 4)
    cmymv = vm.groupby(CMYM_COLS)[['hit_run', 'towed', 'disabled']].sum()
    sql.write(cmymv, 'cmymv', str(out), idxs=[tuple(CMYM_COLS)], replace=False)
    cmyv = sum_idx_col(cmymv, 'm', str(out), tbl_suffix='v')
    cymv = sum_idx_col(cmymv, 'mc', str(out), tbl_suffix='v')
    cyv = sum_idx_col(cymv, 'm', str(out), tbl_suffix='v')
    ymv = sum_idx_col(cymv, 'cc', str(out), tbl_suffix='v')
    yv = sum_idx_col(ymv, 'm', str(out), tbl_suffix='v', page_size=2**16)

    if not skip_upload:
        import boto3
        from os.path import basename
        err(f'Uploading {out} to s3://nj-crashes/njdot/data/{basename(str(out))}…')
        s3 = boto3.client('s3')
        s3.upload_file(str(out), Bucket='nj-crashes', Key=f'njdot/data/{basename(str(out))}')
        err('Upload complete.')


if __name__ == '__main__':
    main()
