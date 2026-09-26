"""Road-scoped artifacts for the map's road selection (specs/road-name-normalization-and-search.md,
Layer 4b phase 1): select a whole SRI route on the map → its crashes in a table → export.

All outputs are parquet under `www/public/njdot/roads/`, synced to `$NJC_S3/njdot/roads` and read
in the browser by DuckDB-WASM with ranged reads, so each is sorted for row-group pruning:

- `crashes-by-sri.parquet`: crashes with an SRI, sorted `(sri, mp, dt, id)` → one route is a
  contiguous range.
- `sri-geom.parquet`: `nj_mp_tenths` polylines sorted `(sri, mp)` → one route's geometry.
- `sri-hit.parquet`: the same points sorted by S2 cell (level `HIT_S2_LEVEL`), so row groups are
  spatially compact and a click's `lat/lon BETWEEN` bbox filter prunes on row-group stats.
- `sris.parquet`: one row per SRI (name, MP range, bbox, crash counts), sorted by `sri`.
"""
import os
import subprocess
from os.path import join

import click
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nj_crashes.utils.log import err
from njdot.load import load_crashes_with_aashto
from njdot.map_base import _build_base
from njdot.paths import DOT_DATA, ROADS_DIR, ROADS_S3
from njdot.s2 import latlng_to_id

from .base import njdot
from .cells import MAP_INPUT_COLS

MP_TENTHS = join(DOT_DATA, 'nj_mp_tenths.parquet')
HIT_S2_LEVEL = 16
# Crash columns shipped for the table / export (plus `lat`, `lon`).
CRASH_COLS = [
    'sri', 'mp', 'id', 'year', 'dt', 'cc', 'mc', 'case', 'severity',
    'tk', 'ti', 'pk', 'pi', 'tv', 'road', 'cross_street', 'route',
]
ROW_GROUP = {
    'crashes-by-sri': 25_000,
    'sri-geom': 25_000,
    # Smaller groups → a click's bbox reads fewer bytes.
    'sri-hit': 8_000,
    'sris': 25_000,
}


def crashes_by_sri(crashes: pd.DataFrame, latlon: pd.DataFrame) -> pd.DataFrame:
    """Crashes with a non-empty SRI, joined to their effective `lat`/`lon` (left join on the index,
    so ungeocoded crashes are kept), sorted `(sri, mp, dt, id)`."""
    df = crashes[crashes['sri'].notna() & (crashes['sri'] != '')]
    df = df[CRASH_COLS].join(latlon[['lat', 'lon']], how='left')
    return df.sort_values(['sri', 'mp', 'dt', 'id'], kind='stable', na_position='last').reset_index(drop=True)


def sri_geom(mp: pd.DataFrame) -> pd.DataFrame:
    """`nj_mp_tenths` → `(sri, mp, sld_name, lon, lat)`, sorted `(sri, mp)`."""
    df = mp.rename(columns={'SRI': 'sri', 'MP': 'mp', 'SLD_NAME': 'sld_name'})[['sri', 'mp', 'sld_name', 'lon', 'lat']]
    return df.sort_values(['sri', 'mp'], kind='stable').reset_index(drop=True)


def sri_hit(geom: pd.DataFrame, level: int = HIT_S2_LEVEL) -> pd.DataFrame:
    """`geom` re-sorted by S2 cell (then `sri`, `mp`) for spatial row-group pruning."""
    cell = latlng_to_id(geom['lat'].to_numpy(), geom['lon'].to_numpy(), level)
    order = np.lexsort((geom['mp'].to_numpy(), geom['sri'].to_numpy(), cell))
    return geom.iloc[order].reset_index(drop=True)


def sris(geom: pd.DataFrame, crashes: pd.DataFrame) -> pd.DataFrame:
    """One row per SRI in `geom`: most common `sld_name`, MP range, bbox, and crash counts."""
    g = geom.groupby('sri')
    name = (
        geom.groupby(['sri', 'sld_name']).size().rename('n').reset_index()
        .sort_values(['sri', 'n', 'sld_name'], ascending=[True, False, True])
        .drop_duplicates('sri').set_index('sri')['sld_name']
    )
    out = pd.DataFrame({
        'sld_name': name,
        'mp_min': g['mp'].min(),
        'mp_max': g['mp'].max(),
        'lon_min': g['lon'].min(),
        'lat_min': g['lat'].min(),
        'lon_max': g['lon'].max(),
        'lat_max': g['lat'].max(),
    })
    counts = (
        crashes.assign(n_crashes=1, n_fatal=crashes['severity'].eq('f'), n_injury=crashes['severity'].eq('i'), n_killed=crashes['tk'])
        .groupby('sri')[['n_crashes', 'n_fatal', 'n_injury', 'n_killed']].sum()
    )
    out = out.join(counts, how='left')
    for col in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        out[col] = out[col].fillna(0).astype('int32')
    return out.sort_index().rename_axis('sri').reset_index()


def write(df: pd.DataFrame, path: str, row_group_size: int):
    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, path, row_group_size=row_group_size, compression='zstd', write_statistics=True)
    err(f'  {path}: {len(df):,} rows, {os.path.getsize(path) / 2**20:.1f} MiB')


@njdot.group('roads')
def roads():
    """Road-selection artifacts (crashes / geometry by SRI)."""


@roads.command('build')
@click.option('-m', '--mp-path', default=MP_TENTHS, show_default=True, help='`nj_mp_tenths` parquet')
@click.option('-o', '--out-dir', default=ROADS_DIR, show_default=True, help='Output dir')
def roads_build(mp_path: str, out_dir: str):
    """Build the `roads/` parquets (see module docstring)."""
    os.makedirs(out_dir, exist_ok=True)
    err('Loading crashes...')
    crashes = load_crashes_with_aashto(columns=MAP_INPUT_COLS + ['id'])
    latlon = _build_base(crashes, keep_severities=set())
    by_sri = crashes_by_sri(crashes, latlon)
    del crashes, latlon
    err(f'Loading {mp_path}...')
    geom = sri_geom(pd.read_parquet(mp_path))
    err('Writing...')
    write(by_sri, join(out_dir, 'crashes-by-sri.parquet'), ROW_GROUP['crashes-by-sri'])
    write(geom, join(out_dir, 'sri-geom.parquet'), ROW_GROUP['sri-geom'])
    write(sri_hit(geom), join(out_dir, 'sri-hit.parquet'), ROW_GROUP['sri-hit'])
    write(sris(geom, by_sri), join(out_dir, 'sris.parquet'), ROW_GROUP['sris'])


@roads.command('sync')
@click.option('-n', '--dry-run', is_flag=True, help='Show what would be uploaded without uploading')
@click.option('-u', '--s3-url', default=ROADS_S3, help=f'Sync to this S3 URL (default: {ROADS_S3})')
def roads_sync(dry_run: bool, s3_url: str):
    """Mirror `roads/` to `s3_url` (the map's road-selection fetches)."""
    cmd = ['aws', 's3', 'sync', ROADS_DIR, s3_url, '--delete']
    if dry_run:
        cmd.append('--dryrun')
    err(f'$ {" ".join(cmd)}')
    subprocess.run(cmd, env={**os.environ}, check=True)
