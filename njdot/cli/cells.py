"""Build H3-tagged + sharded crash data for the cells API (#52).

Phases produce, under {out_dir} (default `data/cells/`):

    raw/h3_r{base_res}/{shard_cell}.parquet   # Phase 1: one per r{shard_res} parent
    pyramid/r{N}/{shard_cell}.parquet         # Phase 2: per-resolution rollups (N in PYRAMID_LEVELS)
    manifest.json

`shard_cell` is rendered as the H3 cell's hex string at `shard_res` (default
r4 — NJ has ~10–15 non-empty r4 cells). Within each raw shard, rows are
sorted by `h3_r{base_res}` (int64) so parquet row-group min/max statistics
give the worker tree-structured pruning at any coarser N. Pyramid shards
sort by `(h3_rN, year)`.

See specs/cfw-cells-pipeline.md and specs/cfw-cells-api.md.
"""
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from time import time

import click
import h3
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from h3.api import numpy_int as h3i

from nj_crashes.utils.log import err
from njdot import s2
from njdot.cli.base import compute
from njdot.cli.export_map_data import _build_base
from njdot.load import load_crashes_with_aashto


# Subset of crashes.parquet that `_build_base` needs (mirrors export_map_v2).
# Reading a column subset avoids a pyarrow "Unknown error: Wrapping" exception
# when the full per-table schema round-trips through pandas.
MAP_INPUT_COLS = [
    'year', 'dt', 'cc', 'mc', 'case', 'severity',
    'tk', 'ti', 'pk', 'pi', 'tv',
    'olat', 'olon', 'ilat', 'ilon',
    'road', 'cross_street', 'route', 'sri', 'mp',
]


BASE_RES_DEFAULT = 14
SHARD_RES_DEFAULT = 4
PYRAMID_LEVELS_DEFAULT = (6, 7, 8, 9, 10, 11, 12, 13)
TOPK_DEFAULT = 10
SCHEMA_VERSION = 4

# Resolutions covered by `hex-sld.parquet` (r6-r11). Pyramid rows at a finer
# `data_res` inherit sld from their r{SLD_MAX_RES} ancestor — same fallback the
# worker's `joinSld` applies (see cells-api/src/cells.ts). Baking these columns
# into every pyramid row at build time replaces that runtime join.
SLD_MAX_RES = 11
SLD_COLS = ('sld_name', 'cross_sld_name', 'mun', 'county')
SLD_PATH_DEFAULT = Path('www/public/njdot/map/v2/hex-sld.parquet')

OUT_DIR_DEFAULT = Path('data/cells')
# Data resolutions rolled into the D1 SQLite (all built pyramid levels).
# All of r6-r15 fits in ~405 MB (4% of D1's 10 GB); missing levels skip.
CELLS_DB_LEVELS_DEFAULT = tuple(range(6, 16))
CELLS_DB_COUNT_COLS = ('n_fatal', 'n_inj_ped', 'n_inj_other', 'n_pdo', 'n_vehs')

# --- S2 grid (specs/s2-pyramid.md) ---
# S2 steps 4× area / 2× linear per level (vs H3's 7× / 2.65×), so the same
# zoom span spans ~1.4× more levels. The raw index caches each crash's cell
# id at `S2_BASE_LEVEL` (the finest data level); every coarser level's cell
# is derived by UBIGINT bit-math (`njdot.s2.parent_sql`), byte-identical to
# both `s2sphere` and the client's `nodes2ts` (see `tests/test_s2.py`).
S2_BASE_LEVEL_DEFAULT = 16       # finest data level; raw stores cell id here
S2_SHARD_LEVEL_DEFAULT = 4       # ~15 level-4 tokens cover NJ
# Levels rolled into cells-s2.db / the pyramid. l4-l5 are near-empty (NJ is
# ~15 cells at l4) but cheap, and the statewide viewport picks them; l16 is
# the base. Client picker max is 17 → the worker clamps 17→16 (phase 4).
S2_LEVELS_DEFAULT = tuple(range(4, 17))
R2_BUCKET_DEFAULT = 'nj-crashes'
R2_PREFIX_DEFAULT = 'cells'
R2_PROFILE_DEFAULT = 'cf'


def _h3_int_col(lat: np.ndarray, lon: np.ndarray, res: int) -> np.ndarray:
    """Vectorize h3.latlng_to_cell over (lat, lon) → int64 numpy array."""
    n = len(lat)
    out = np.empty(n, dtype=np.int64)
    # h3 v4 numpy_int variant returns int directly (no string roundtrip).
    for i in range(n):
        out[i] = h3i.latlng_to_cell(float(lat[i]), float(lon[i]), res)
    return out


def _parent_int_col(cells: np.ndarray, res: int) -> np.ndarray:
    n = len(cells)
    out = np.empty(n, dtype=np.int64)
    for i in range(n):
        out[i] = h3i.cell_to_parent(int(cells[i]), res)
    return out


def _str_to_int_col(cells: np.ndarray) -> np.ndarray:
    """Vectorize h3.str_to_int over an array of h3 hex strings → int64."""
    n = len(cells)
    out = np.empty(n, dtype=np.int64)
    for i in range(n):
        out[i] = h3i.str_to_int(cells[i])
    return out


# Columns `_build_pyramid_level` actually consumes (counts agg + topK struct).
# The raw base carries ~10 more (cc, mc, road, cross_street, route, sri, mp,
# lat, lon, geocode_src) — dropping them before the fork roughly halves the
# per-worker footprint (the string road cols are the heavy ones) and, crucially,
# shrinks the full-frame copy each worker makes in `base.assign(...)`.
def _pyramid_keep_cols(base_res: int) -> list[str]:
    return [f'h3_r{base_res}', 'year', 'dt', 'case', 'severity', 'ti', 'pi', 'tk', 'pk', 'tv']


def _load_sld_lookup(sld_path: Path) -> pd.DataFrame:
    """Load `hex-sld.parquet` (r6-r11 road/muni labels) keyed by int64 h3.

    Returns a DataFrame indexed by int64 h3 with `SLD_COLS`, ready for
    `.reindex(<int64 h3 array>)`. String h3 → int64 once here so the per-combo
    join is a hash lookup on int keys (no per-row string round-trip)."""
    sld = pd.read_parquet(sld_path, columns=['h3', *SLD_COLS])
    sld['h3_int'] = _str_to_int_col(sld['h3'].to_numpy())
    for c in SLD_COLS:
        sld[c] = sld[c].astype('string')
    # `.reindex` (per-combo join) requires a unique index; hex-sld should have
    # one row per h3, but dedup defensively so a stray dup can't abort a build.
    sld = sld.drop(columns='h3').drop_duplicates('h3_int').set_index('h3_int')
    return sld


def _git_sha() -> str:
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return 'unknown'


@compute.group('cells')
def cells():
    """Build H3-tagged + sharded crash data for the cells API."""


@cells.command('raw')
@click.option('-b', '--base-res', type=int, default=None, help=f'Base resolution/level (default: h3={BASE_RES_DEFAULT}, s2={S2_BASE_LEVEL_DEFAULT})')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing output directory')
@click.option('-g', '--grid', type=click.Choice(['h3', 's2']), default='h3', help='Cell grid (default: h3)')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT, help=f'Output root (default: {OUT_DIR_DEFAULT})')
@click.option('-s', '--shard-res', type=int, default=None, help=f'Shard resolution/level (default: h3={SHARD_RES_DEFAULT}, s2={S2_SHARD_LEVEL_DEFAULT})')
def cells_raw(base_res: int | None, force: bool, grid: str, out_dir: Path, shard_res: int | None):
    """Phase 1: tag crashes with a cell id at `base_res`, sort, shard by its
    `shard_res` parent. `--grid h3` writes int64 h3 cells; `--grid s2` writes
    uint64 S2 cell ids (see specs/s2-pyramid.md)."""
    if base_res is None:
        base_res = S2_BASE_LEVEL_DEFAULT if grid == 's2' else BASE_RES_DEFAULT
    if shard_res is None:
        shard_res = S2_SHARD_LEVEL_DEFAULT if grid == 's2' else SHARD_RES_DEFAULT
    cell_name = f's2_l{base_res}' if grid == 's2' else f'h3_r{base_res}'
    raw_dir = out_dir / 'raw' / cell_name
    if raw_dir.exists() and any(raw_dir.iterdir()):
        if not force:
            err(f'{raw_dir} non-empty; use -f/--force to overwrite')
            return
        for p in raw_dir.glob('*.parquet'):
            p.unlink()
    raw_dir.mkdir(parents=True, exist_ok=True)

    df = load_crashes_with_aashto(columns=MAP_INPUT_COLS)
    n_total = len(df)

    err('Computing effective lat/lon (via _build_base)...')
    base = _build_base(df, keep_severities=set())
    n_geo = len(base)
    n_drop = n_total - n_geo
    err(f'  {n_geo:,} rows with lat/lon (dropped {n_drop:,} ungeocoded, {n_drop / n_total:.1%})')

    err('Re-attaching `year` from source...')
    base['year'] = df.loc[base.index, 'year'].astype('int16')

    lat = base['lat'].to_numpy()
    lon = base['lon'].to_numpy()
    err(f'Computing {cell_name} for {n_geo:,} rows ({grid})...')
    t0 = time()
    if grid == 's2':
        cells = s2.latlng_to_id(lat, lon, base_res)          # uint64
        shard_arr = s2.parent_id(cells, shard_res)           # uint64
        shard_name = lambda v: s2.id_to_token(int(v))
    else:
        cells = _h3_int_col(lat, lon, base_res)              # int64
        shard_arr = _parent_int_col(cells, shard_res)        # int64
        shard_name = lambda v: h3.int_to_str(int(v))
    err(f'  {time() - t0:.1f}s')
    base[cell_name] = cells

    n_shards = len(np.unique(shard_arr))
    err(f'  shard at {shard_res}: {n_shards} shards')
    base['__shard'] = shard_arr

    err(f'Sorting by (shard, {cell_name})...')
    # Token order == id order for S2 (tests/test_s2.py), so sorting by the
    # numeric id also sorts by token → the worker's range-scan pruning holds.
    base = base.sort_values(['__shard', cell_name], kind='mergesort')

    err('Writing shards (zstd, row_group_size=20000)...')
    counts: dict[str, int] = {}
    t0 = time()
    for shard, sub in base.groupby('__shard', sort=False):
        out = sub.drop(columns='__shard')
        name = shard_name(shard)
        path = raw_dir / f'{name}.parquet'
        out.to_parquet(path, row_group_size=20_000, index=False, compression='zstd')
        counts[name] = len(out)
    err(f'  wrote {len(counts)} shards, total {sum(counts.values()):,} rows in {time() - t0:.1f}s')

    assert sum(counts.values()) == n_geo, f'shard sum {sum(counts.values())} != n_geo {n_geo}'
    err('Row-count parity OK.')


def _build_pyramid_level(
    base: pd.DataFrame,
    h3_base_col: str,
    level: int,
    shard_res: int,
    topk: int,
    out_dir: Path,
    sld: pd.DataFrame | None = None,
    row_group_size: int = 20_000,
) -> dict[str, int]:
    """Aggregate raw rows to a pyramid level and write per-shard parquet files.

    Returns {shard_hex: row_count}. Input `base` must already be sorted by `dt`
    descending — groupby(sort=False).head(topk) then yields the K most-recent
    crashes per (shard, h3_rN, year).

    When `sld` (int64-h3-indexed label table from `_load_sld_lookup`) is given,
    bakes `SLD_COLS` into every row: key on the cell's own h3 for
    `level <= SLD_MAX_RES`, else on its r{SLD_MAX_RES} ancestor.
    """
    h3_col = f'h3_r{level}'
    err(f'  parents r{level}...')
    t0 = time()
    h3_n = _parent_int_col(base[h3_base_col].to_numpy(), level)
    shard_int = _parent_int_col(h3_n, shard_res)
    err(f'    {time() - t0:.1f}s')

    work = base.assign(**{h3_col: h3_n, '__shard': shard_int})

    err(f'  groupby + sums...')
    t0 = time()
    grp_keys = ['__shard', h3_col, 'year']
    work['_n_fatal'] = (work['severity'] == 'f').astype('int32')
    work['_n_inj'] = (work['severity'] == 'i').astype('int32')
    work['_n_pdo'] = (work['severity'] == 'p').astype('int32')
    inj_other = (work['ti'].fillna(0).astype('int32') - work['pi'].fillna(0).astype('int32')).clip(lower=0)
    work['_n_inj_other'] = inj_other
    sums = (
        work.groupby(grp_keys, sort=False)
        .agg(
            n_crashes=('case', 'size'),
            n_fatal=('_n_fatal', 'sum'),
            n_inj=('_n_inj', 'sum'),
            n_pdo=('_n_pdo', 'sum'),
            n_killed=('tk', 'sum'),
            n_killed_ped=('pk', 'sum'),
            n_injured=('ti', 'sum'),
            n_inj_ped=('pi', 'sum'),
            n_inj_other=('_n_inj_other', 'sum'),
            n_vehs=('tv', 'sum'),
        )
        .reset_index()
    )
    err(f'    {time() - t0:.1f}s, {len(sums):,} cell-years')

    err(f'  topK={topk}...')
    t0 = time()
    topk_rows = work.groupby(grp_keys, sort=False).head(topk).copy()
    # Vectorize the per-row struct construction: zip → list of dicts
    yr_arr = topk_rows['year'].astype('int16').to_numpy()
    dt_arr = topk_rows['dt'].astype('int64').to_numpy()
    case_arr = topk_rows['case'].astype('string').fillna('').to_numpy()
    sev_arr = topk_rows['severity'].astype('string').fillna('').to_numpy()
    topk_rows['_struct'] = [
        {'year': int(y), 'dt': int(d), 'case': str(c), 'severity': str(s)}
        for y, d, c, s in zip(yr_arr, dt_arr, case_arr, sev_arr)
    ]
    topk_lists = (
        topk_rows.groupby(grp_keys, sort=False)['_struct']
        .agg(list)
        .rename('topK')
        .reset_index()
    )
    err(f'    {time() - t0:.1f}s')

    out = sums.merge(topk_lists, on=grp_keys, how='left')
    out['year'] = out['year'].astype('int16')
    for col in ('n_crashes', 'n_fatal', 'n_inj', 'n_pdo', 'n_killed', 'n_killed_ped', 'n_injured', 'n_inj_ped', 'n_inj_other', 'n_vehs'):
        out[col] = out[col].fillna(0).astype('int32')

    if sld is not None:
        err(f'  sld join...')
        t0 = time()
        key = out[h3_col].to_numpy()
        if level > SLD_MAX_RES:
            key = _parent_int_col(key, SLD_MAX_RES)
        aligned = sld.reindex(key)
        for c in SLD_COLS:
            out[c] = aligned[c].to_numpy()
        n_hit = aligned['sld_name'].notna().sum()
        err(f'    {time() - t0:.1f}s, {n_hit:,}/{len(out):,} rows with sld_name')

    err(f'  sort + write...')
    t0 = time()
    out = out.sort_values(['__shard', h3_col, 'year'], kind='mergesort')
    out_dir.mkdir(parents=True, exist_ok=True)
    level_dir = out_dir
    counts: dict[str, int] = {}
    cols_out = [h3_col, 'year', 'n_crashes', 'n_fatal', 'n_inj', 'n_pdo', 'n_killed', 'n_killed_ped', 'n_injured', 'n_inj_ped', 'n_inj_other', 'n_vehs', 'topK']
    # Pin topK's nested `year` to int16; pyarrow's default inference picks
    # int64 from list-of-dicts (Python int), which inflates each cell-year
    # row by ~6 bytes per topK element.
    topk_struct = pa.struct([
        ('case', pa.string()),
        ('dt', pa.int64()),
        ('severity', pa.string()),
        ('year', pa.int16()),
    ])
    schema_fields = [
        (h3_col, pa.int64()),
        ('year', pa.int16()),
        *((c, pa.int32()) for c in (
            'n_crashes', 'n_fatal', 'n_inj', 'n_pdo', 'n_killed', 'n_killed_ped',
            'n_injured', 'n_inj_ped', 'n_inj_other', 'n_vehs',
        )),
        ('topK', pa.list_(topk_struct)),
    ]
    if sld is not None:
        cols_out = [*cols_out, *SLD_COLS]
        schema_fields += [(c, pa.string()) for c in SLD_COLS]
    schema = pa.schema(schema_fields)
    for shard, sub in out.groupby('__shard', sort=False):
        shard_hex = h3.int_to_str(int(shard))
        path = level_dir / f'{shard_hex}.parquet'
        table = pa.Table.from_pandas(sub[cols_out], schema=schema, preserve_index=False)
        pq.write_table(table, path, row_group_size=row_group_size, compression='zstd')
        counts[shard_hex] = len(sub)
    err(f'    {time() - t0:.1f}s, {len(counts)} shards, {sum(counts.values()):,} rows')
    return counts


def _s2_pyramid_keep_cols(base_level: int) -> list[str]:
    return [f's2_l{base_level}', 'year', 'dt', 'case', 'severity', 'ti', 'pi', 'tk', 'pk', 'tv']


def _load_s2_sld(sld_path: Path) -> pd.DataFrame:
    """Load `s2-sld.parquet` (token → labels), indexed by token for `.reindex`."""
    sld = pd.read_parquet(sld_path, columns=['cellid', *SLD_COLS])
    for c in SLD_COLS:
        sld[c] = sld[c].astype('string')
    return sld.drop_duplicates('cellid').set_index('cellid')


_PYRAMID_COUNT_COLS = (
    'n_crashes', 'n_fatal', 'n_inj', 'n_pdo', 'n_killed', 'n_killed_ped',
    'n_injured', 'n_inj_ped', 'n_inj_other', 'n_vehs',
)


def _build_pyramid_level_s2(
    base: pd.DataFrame,
    s2col: str,
    level: int,
    shard_level: int,
    topk: int,
    out_dir: Path,
    sld: pd.DataFrame | None = None,
    row_group_size: int = 4096,
) -> dict[str, int]:
    """S2 analog of `_build_pyramid_level`: aggregate raw rows to `(cellid,
    year)` counts + topK, sharded by l{shard_level} token. `base` must be
    sorted by `dt` desc (for `head(topk)` recency). Parent ids are derived by
    bit-math; `cellid` is the S2 token. Labels join `sld` on the cell's own
    token."""
    err(f'  parents l{level}...')
    t0 = time()
    cell_ids = s2.parent_id(base[s2col].to_numpy(), level)      # uint64
    shard_ids = s2.parent_id(cell_ids, shard_level)             # uint64
    err(f'    {time() - t0:.1f}s')

    work = base.assign(__cell=cell_ids, __shard=shard_ids)
    grp_keys = ['__shard', '__cell', 'year']
    work['_n_fatal'] = (work['severity'] == 'f').astype('int32')
    work['_n_inj'] = (work['severity'] == 'i').astype('int32')
    work['_n_pdo'] = (work['severity'] == 'p').astype('int32')
    work['_n_inj_other'] = (work['ti'].fillna(0).astype('int32') - work['pi'].fillna(0).astype('int32')).clip(lower=0)

    err('  groupby + sums...')
    t0 = time()
    sums = (
        work.groupby(grp_keys, sort=False)
        .agg(
            n_crashes=('case', 'size'),
            n_fatal=('_n_fatal', 'sum'),
            n_inj=('_n_inj', 'sum'),
            n_pdo=('_n_pdo', 'sum'),
            n_killed=('tk', 'sum'),
            n_killed_ped=('pk', 'sum'),
            n_injured=('ti', 'sum'),
            n_inj_ped=('pi', 'sum'),
            n_inj_other=('_n_inj_other', 'sum'),
            n_vehs=('tv', 'sum'),
        )
        .reset_index()
    )
    err(f'    {time() - t0:.1f}s, {len(sums):,} cell-years')

    err(f'  topK={topk}...')
    t0 = time()
    topk_rows = work.groupby(grp_keys, sort=False).head(topk).copy()
    yr_arr = topk_rows['year'].astype('int16').to_numpy()
    dt_arr = topk_rows['dt'].astype('int64').to_numpy()
    case_arr = topk_rows['case'].astype('string').fillna('').to_numpy()
    sev_arr = topk_rows['severity'].astype('string').fillna('').to_numpy()
    topk_rows['_struct'] = [
        {'year': int(y), 'dt': int(d), 'case': str(c), 'severity': str(s)}
        for y, d, c, s in zip(yr_arr, dt_arr, case_arr, sev_arr)
    ]
    topk_lists = (
        topk_rows.groupby(grp_keys, sort=False)['_struct']
        .agg(list)
        .rename('topK')
        .reset_index()
    )
    err(f'    {time() - t0:.1f}s')

    out = sums.merge(topk_lists, on=grp_keys, how='left')
    out['year'] = out['year'].astype('int16')
    for col in _PYRAMID_COUNT_COLS:
        out[col] = out[col].fillna(0).astype('int32')

    # int64 cell id → token, computed once per unique cell (not per cell-year).
    uniq = np.unique(out['__cell'].to_numpy())
    tok_map = {int(u): s2.id_to_token(int(u)) for u in uniq}
    out['cellid'] = out['__cell'].map(lambda v: tok_map[int(v)]).astype('string')

    if sld is not None:
        err('  sld join...')
        t0 = time()
        aligned = sld.reindex(out['cellid'].to_numpy())
        for c in SLD_COLS:
            out[c] = aligned[c].to_numpy()
        n_hit = aligned['sld_name'].notna().sum()
        err(f'    {time() - t0:.1f}s, {n_hit:,}/{len(out):,} rows with sld_name')

    err('  sort + write...')
    t0 = time()
    # Sort by cell id (== token order) so worker range-scan pruning holds.
    out = out.sort_values(['__shard', '__cell', 'year'], kind='mergesort')
    out_dir.mkdir(parents=True, exist_ok=True)
    topk_struct = pa.struct([
        ('case', pa.string()),
        ('dt', pa.int64()),
        ('severity', pa.string()),
        ('year', pa.int16()),
    ])
    cols_out = ['cellid', 'year', *_PYRAMID_COUNT_COLS, 'topK']
    schema_fields = [
        ('cellid', pa.string()),
        ('year', pa.int16()),
        *((c, pa.int32()) for c in _PYRAMID_COUNT_COLS),
        ('topK', pa.list_(topk_struct)),
    ]
    if sld is not None:
        cols_out = [*cols_out, *SLD_COLS]
        schema_fields += [(c, pa.string()) for c in SLD_COLS]
    schema = pa.schema(schema_fields)
    counts: dict[str, int] = {}
    for shard, sub in out.groupby('__shard', sort=False):
        shard_tok = s2.id_to_token(int(shard))
        path = out_dir / f'{shard_tok}.parquet'
        table = pa.Table.from_pandas(sub[cols_out], schema=schema, preserve_index=False)
        pq.write_table(table, path, row_group_size=row_group_size, compression='zstd')
        counts[shard_tok] = len(sub)
    err(f'    {time() - t0:.1f}s, {len(counts)} shards, {sum(counts.values()):,} rows')
    return counts


def _cells_pyramid_s2(base_level, force, topk, levels, out_dir, row_group_size, shard_level, sld_path):
    """Build the S2 pyramid: `s2_pyramid/s2_l{level}/{token}.parquet`."""
    if base_level is None:
        raw_root = out_dir / 'raw'
        cand = sorted(
            int(p.name[len('s2_l'):]) for p in raw_root.glob('s2_l*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw S2 index under {raw_root}; run `compute cells raw --grid s2` first')
            raise SystemExit(1)
        base_level = cand[-1]
    if shard_level is None:
        shard_level = S2_SHARD_LEVEL_DEFAULT
    level_ints = sorted(int(x) for x in (levels or ','.join(map(str, S2_LEVELS_DEFAULT))).split(',') if x.strip())
    pyramid_dir = out_dir / 's2_pyramid'
    level_dirs = [pyramid_dir / f's2_l{lv}' for lv in level_ints]
    existing = [d for d in level_dirs if d.exists() and any(d.glob('*.parquet'))]
    if existing and not force:
        err(f'level dirs already populated: {[d.name for d in existing]}; use -f/--force to overwrite')
        return
    for d in existing:
        for p in d.glob('*.parquet'):
            p.unlink()
    pyramid_dir.mkdir(parents=True, exist_ok=True)

    s2col = f's2_l{base_level}'
    raw_dir = out_dir / 'raw' / s2col
    raw_paths = sorted(raw_dir.glob('*.parquet'))
    if not raw_paths:
        err(f'No raw S2 shards in {raw_dir}; run `compute cells raw --grid s2` first')
        raise SystemExit(1)
    keep = _s2_pyramid_keep_cols(base_level)
    err(f'Loading {len(raw_paths)} raw S2 shards from {raw_dir} (cols: {keep})...')
    t0 = time()
    base = pd.concat([pd.read_parquet(p, columns=keep) for p in raw_paths], ignore_index=True)
    err(f'  {len(base):,} rows in {time() - t0:.1f}s')
    err('Sorting by dt desc (once, for topK head() correctness)...')
    t0 = time()
    base = base.sort_values('dt', ascending=False, kind='mergesort')
    err(f'  {time() - t0:.1f}s')

    if sld_path is None:
        sld_path = out_dir / 's2-sld.parquet'
    sld = None
    if str(sld_path) and Path(sld_path).exists():
        err(f'Loading s2-sld from {sld_path}...')
        t0 = time()
        sld = _load_s2_sld(Path(sld_path))
        err(f'  {len(sld):,} labelled cells in {time() - t0:.1f}s')
    else:
        err(f'  no s2-sld at {sld_path}; pyramid rows will omit label columns')

    # Sequential per-level (S2 has far fewer cells than H3 at the base level,
    # so the topK object graph stays small — no fork pool needed).
    err(f'\nBuilding {len(level_ints)} levels (shard l{shard_level}, rgs={row_group_size})...')
    t0 = time()
    total = 0
    for lv in level_ints:
        err(f'=== l{lv} ===')
        counts = _build_pyramid_level_s2(
            base, s2col, lv, shard_level, topk,
            pyramid_dir / f's2_l{lv}', sld=sld, row_group_size=row_group_size,
        )
        total += sum(counts.values())
    err(f'All levels done in {time() - t0:.1f}s, {total:,} total rows')


@cells.command('pyramid')
@click.option('-b', '--base-res', type=int, default=None)
@click.option('-f', '--force', is_flag=True, help='Overwrite existing pyramid output')
@click.option('-g', '--grid', type=click.Choice(['h3', 's2']), default='h3', help='Cell grid (default: h3)')
@click.option('-j', '--jobs', type=int, default=0, help='Parallel level workers (0 = min(#levels, cpu_count))')
@click.option('-k', '--topk', type=int, default=TOPK_DEFAULT, help=f'topK most-recent crashes per cell-year (default: {TOPK_DEFAULT})')
@click.option('-l', '--levels', default=None, help='Comma-separated pyramid levels')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-r', '--row-group-size', type=int, default=4096, help='Parquet row-group size (smaller → finer worker range pruning; default: 4096)')
@click.option('-s', '--shard-res', type=int, default=None)
@click.option('-S', '--sld-path', type=click.Path(path_type=Path), default=None, help='sld parquet to bake into rows, or "" to skip (default: hex-sld.parquet for h3, s2-sld.parquet for s2)')
def cells_pyramid(base_res: int | None, force: bool, grid: str, jobs: int, topk: int, levels: str | None, out_dir: Path, row_group_size: int, shard_res: int | None, sld_path: Path | None):
    """Phase 2: per-(cell, year) rollups → counts + topK + sld, sharded parquet.

    Consolidated layout: one `{pyramid_dir}/{level}/{shard}.parquet` per shard,
    cell-sorted with `row_group_size` row-groups so the worker prunes to
    viewport row-groups by cell range. `--grid s2` writes
    `s2_pyramid/s2_l{level}/{token}.parquet` (see specs/s2-pyramid.md); default
    `--grid h3` writes `pyramid/r{N}/{hex}.parquet`."""
    if grid == 's2':
        return _cells_pyramid_s2(base_res, force, topk, levels, out_dir, row_group_size, shard_res, sld_path)
    if base_res is None:
        base_res = BASE_RES_DEFAULT
    if shard_res is None:
        shard_res = SHARD_RES_DEFAULT
    if levels is None:
        levels = ','.join(map(str, PYRAMID_LEVELS_DEFAULT))
    if sld_path is None:
        sld_path = SLD_PATH_DEFAULT
    level_ints = sorted(int(x) for x in levels.split(',') if x.strip())
    pyramid_dir = out_dir / 'pyramid'
    level_dirs = [pyramid_dir / f'r{lv}' for lv in level_ints]
    existing = [d for d in level_dirs if d.exists() and any(d.glob('*.parquet'))]
    if existing and not force:
        err(f'level dirs already populated: {[d.name for d in existing]}; use -f/--force to overwrite')
        return
    for d in existing:
        for p in d.glob('*.parquet'):
            p.unlink()
    pyramid_dir.mkdir(parents=True, exist_ok=True)

    raw_dir = out_dir / 'raw' / f'h3_r{base_res}'
    raw_paths = sorted(raw_dir.glob('*.parquet'))
    if not raw_paths:
        err(f'No raw shards in {raw_dir}; run `compute cells raw` first')
        raise SystemExit(1)
    keep = _pyramid_keep_cols(base_res)
    err(f'Loading {len(raw_paths)} raw shards from {raw_dir} (cols: {keep})...')
    t0 = time()
    base = pd.concat([pd.read_parquet(p, columns=keep) for p in raw_paths], ignore_index=True)
    err(f'  {len(base):,} rows in {time() - t0:.1f}s')

    err('Sorting by dt desc (once, for topK head() correctness)...')
    t0 = time()
    base = base.sort_values('dt', ascending=False, kind='mergesort')
    err(f'  {time() - t0:.1f}s')

    sld = None
    if str(sld_path):
        err(f'Loading sld lookup from {sld_path}...')
        t0 = time()
        sld = _load_sld_lookup(sld_path)
        err(f'  {len(sld):,} labelled cells in {time() - t0:.1f}s')

    global _MP_BASE, _MP_SLD, _MP_H3_BASE_COL, _MP_TOPK, _MP_PYRAMID_DIR, _MP_SHARD_RES, _MP_RGS
    _MP_BASE = base
    _MP_SLD = sld
    _MP_H3_BASE_COL = f'h3_r{base_res}'
    _MP_TOPK = topk
    _MP_PYRAMID_DIR = pyramid_dir
    _MP_SHARD_RES = shard_res
    _MP_RGS = row_group_size

    n_jobs = jobs if jobs > 0 else min(len(level_ints), os.cpu_count() or 1)
    err(f'\nBuilding {len(level_ints)} levels (shard r{shard_res}, rgs={row_group_size}) across {n_jobs} worker(s)...')
    t0 = time()
    if n_jobs == 1:
        for level in level_ints:
            _level_task(level)
    else:
        from multiprocessing import get_context
        with get_context('fork').Pool(n_jobs) as pool:
            for level, n in pool.imap_unordered(_level_task, level_ints):
                err(f'  ✓ r{level}: {n:,} rows')
    err(f'All levels done in {time() - t0:.1f}s')


def _parse_combos(spec: str) -> list[tuple[int, int]]:
    """Parse `--combos s5:r9,s6:r10,...` → [(shard_res, data_res), ...]."""
    out: list[tuple[int, int]] = []
    for tok in spec.split(','):
        tok = tok.strip()
        if not tok:
            continue
        if ':' not in tok:
            raise click.BadParameter(f'expected "s{{N}}:r{{M}}" or "{{N}}:{{M}}", got {tok!r}')
        s, r = tok.split(':', 1)
        s = s.lstrip('s')
        r = r.lstrip('r')
        s_i, r_i = int(s), int(r)
        if s_i >= r_i:
            raise click.BadParameter(f'combo {tok}: shard_res {s_i} must be < data_res {r_i}')
        if not (0 <= s_i <= 15) or not (0 <= r_i <= 15):
            raise click.BadParameter(f'combo {tok}: res must be in [0, 15]')
        out.append((s_i, r_i))
    return out


# Fork-shared state for combo workers. Set once in `cells_pyramid_combos`
# before the pool is created; children inherit via copy-on-write so the
# multi-million-row `base` (and the sld lookup) are never pickled per task.
_MP_BASE: pd.DataFrame | None = None
_MP_SLD: pd.DataFrame | None = None
_MP_H3_BASE_COL: str | None = None
_MP_TOPK: int | None = None
_MP_PYRAMID_DIR: Path | None = None
_MP_SHARD_RES: int | None = None
_MP_RGS: int | None = None


def _level_task(level: int) -> tuple[int, int]:
    """Fork worker: build one consolidated level `pyramid/r{level}/` sharded at
    `_MP_SHARD_RES` (r4) with sld baked. Mirrors `_combo_task` but one
    shard_res, plain `r{level}` output path."""
    counts = _build_pyramid_level(
        _MP_BASE, _MP_H3_BASE_COL, level, _MP_SHARD_RES, _MP_TOPK,
        _MP_PYRAMID_DIR / f'r{level}', sld=_MP_SLD, row_group_size=_MP_RGS,
    )
    return level, sum(counts.values())


def _combo_task(combo: tuple[int, int]) -> tuple[int, int, int]:
    s_res, d_res = combo
    err(f'=== Combo s{s_res} / r{d_res} (D={d_res - s_res}) ===')
    counts = _build_pyramid_level(
        _MP_BASE, _MP_H3_BASE_COL, d_res, s_res, _MP_TOPK,
        _MP_PYRAMID_DIR / f's{s_res}_r{d_res}', sld=_MP_SLD,
    )
    return s_res, d_res, sum(counts.values())


@cells.command('pyramid-combos')
@click.option('-b', '--base-res', type=int, default=BASE_RES_DEFAULT)
@click.option('-c', '--combos', required=True, help='Comma-sep (shard_res, data_res) pairs, e.g. "s5:r9,s6:r10,s7:r11,s8:r12"')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing combo output dirs')
@click.option('-j', '--jobs', type=int, default=0, help='Parallel combo workers (0 = min(#combos, cpu_count))')
@click.option('-k', '--topk', type=int, default=TOPK_DEFAULT)
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-S', '--sld-path', type=click.Path(path_type=Path), default=SLD_PATH_DEFAULT, help=f'hex-sld.parquet to bake into rows, or "" to skip (default: {SLD_PATH_DEFAULT})')
def cells_pyramid_combos(base_res: int, combos: str, force: bool, jobs: int, topk: int, out_dir: Path, sld_path: Path):
    """Multi-resolution pyramid: each `(shard_res, data_res)` combo writes
    to `pyramid/s{shard_res}_r{data_res}/{shard_hex}.parquet`. The
    client picks the combo whose viewport-shard count is in target
    range (typically D = data_res - shard_res = 3-5).

    Combos run in a fork pool (`-j`); `SLD_COLS` are baked into every row
    from `--sld-path` unless it's empty."""
    combo_list = _parse_combos(combos)
    # Coarse→fine: per-worker memory is dominated by the topK object graph,
    # which grows with data_res (fine combos are ~all singleton groups, so
    # head(topk) keeps ~every row). Ordering cheap combos first lets them
    # clear fast, so at most `-j` of the *expensive* fine combos overlap.
    combo_list = sorted(combo_list, key=lambda c: (c[1], c[0]))
    err(f'Generating {len(combo_list)} combos: {combo_list}')
    pyramid_dir = out_dir / 'pyramid'
    pyramid_dir.mkdir(parents=True, exist_ok=True)
    # Pre-check non-empty combo dirs (caller can re-run with -f).
    existing = [c for c in combo_list if (pyramid_dir / f's{c[0]}_r{c[1]}').exists() and any((pyramid_dir / f's{c[0]}_r{c[1]}').glob('*.parquet'))]
    if existing and not force:
        err(f'combo dirs already populated: {existing}; use -f/--force to overwrite')
        return
    for s_res, d_res in existing:
        if force:
            for p in (pyramid_dir / f's{s_res}_r{d_res}').glob('*.parquet'):
                p.unlink()

    raw_dir = out_dir / 'raw' / f'h3_r{base_res}'
    raw_paths = sorted(raw_dir.glob('*.parquet'))
    if not raw_paths:
        err(f'No raw shards in {raw_dir}; run `compute cells raw` first')
        raise SystemExit(1)
    keep = _pyramid_keep_cols(base_res)
    err(f'Loading {len(raw_paths)} raw shards from {raw_dir} (cols: {keep})...')
    t0 = time()
    base = pd.concat([pd.read_parquet(p, columns=keep) for p in raw_paths], ignore_index=True)
    err(f'  {len(base):,} rows in {time() - t0:.1f}s')
    err('Sorting by dt desc (once, for topK head() correctness)...')
    t0 = time()
    base = base.sort_values('dt', ascending=False, kind='mergesort')
    err(f'  {time() - t0:.1f}s')

    sld = None
    if str(sld_path):
        err(f'Loading sld lookup from {sld_path}...')
        t0 = time()
        sld = _load_sld_lookup(sld_path)
        err(f'  {len(sld):,} labelled cells in {time() - t0:.1f}s')

    global _MP_BASE, _MP_SLD, _MP_H3_BASE_COL, _MP_TOPK, _MP_PYRAMID_DIR
    _MP_BASE = base
    _MP_SLD = sld
    _MP_H3_BASE_COL = f'h3_r{base_res}'
    _MP_TOPK = topk
    _MP_PYRAMID_DIR = pyramid_dir

    n_jobs = jobs if jobs > 0 else min(len(combo_list), os.cpu_count() or 1)
    err(f'\nBuilding {len(combo_list)} combos across {n_jobs} worker(s)...')
    t0 = time()
    if n_jobs == 1:
        for combo in combo_list:
            _combo_task(combo)
    else:
        from multiprocessing import get_context
        with get_context('fork').Pool(n_jobs) as pool:
            for s_res, d_res, n in pool.imap_unordered(_combo_task, combo_list):
                err(f'  ✓ s{s_res}_r{d_res}: {n:,} rows')
    err(f'All combos done in {time() - t0:.1f}s')


@cells.command('manifest')
@click.option('-b', '--base-res', type=int, default=BASE_RES_DEFAULT)
@click.option('-l', '--pyramid-levels', default=','.join(map(str, PYRAMID_LEVELS_DEFAULT)), help='Comma-separated pyramid levels')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-s', '--shard-res', type=int, default=SHARD_RES_DEFAULT)
def cells_manifest(base_res: int, pyramid_levels: str, out_dir: Path, shard_res: int):
    """Walk on-disk shards and emit `manifest.json` per cells API spec."""
    levels = [int(x) for x in pyramid_levels.split(',') if x.strip()]
    raw_dir = out_dir / 'raw' / f'h3_r{base_res}'
    if not raw_dir.exists():
        err(f'{raw_dir} does not exist; run `compute cells raw` first')
        raise SystemExit(1)

    raw_shards = sorted(p.stem for p in raw_dir.glob('*.parquet'))
    if not raw_shards:
        err(f'No raw shards found in {raw_dir}')
        raise SystemExit(1)

    row_counts: dict[str, int] = {}
    raw_total = 0
    years_seen: set[int] = set()
    for shard in raw_shards:
        path = raw_dir / f'{shard}.parquet'
        import pyarrow.parquet as pq
        f = pq.ParquetFile(path)
        raw_total += f.metadata.num_rows
        # Pull year range cheaply from RG stats
        idx = f.schema_arrow.get_field_index('year')
        if idx >= 0:
            for rg_i in range(f.metadata.num_row_groups):
                stats = f.metadata.row_group(rg_i).column(idx).statistics
                if stats and stats.has_min_max:
                    years_seen.add(int(stats.min))
                    years_seen.add(int(stats.max))
    row_counts['raw'] = raw_total

    for level in levels:
        pdir = out_dir / 'pyramid' / f'r{level}'
        if not pdir.exists():
            continue
        n = 0
        for p in pdir.glob('*.parquet'):
            import pyarrow.parquet as pq
            n += pq.ParquetFile(p).metadata.num_rows
        row_counts[f'pyramid_r{level}'] = n

    # Multi-resolution combo dirs: `pyramid/s{S}_r{R}/...parquet`.
    # Glob the pyramid root for s*_r* subdirs the combos run produced.
    import re
    pyramid_combos: list[dict] = []
    pyramid_root = out_dir / 'pyramid'
    if pyramid_root.exists():
        combo_re = re.compile(r'^s(\d+)_r(\d+)$')
        combo_dirs = sorted(
            (p for p in pyramid_root.iterdir() if p.is_dir() and combo_re.match(p.name)),
            key=lambda p: tuple(int(x) for x in combo_re.match(p.name).groups()),
        )
        for cdir in combo_dirs:
            m = combo_re.match(cdir.name)
            s_res, d_res = int(m.group(1)), int(m.group(2))
            shards = sorted(p.stem for p in cdir.glob('*.parquet'))
            if not shards:
                continue
            n_rows = 0
            n_bytes = 0
            import pyarrow.parquet as pq
            for sh in shards:
                p = cdir / f'{sh}.parquet'
                n_rows += pq.ParquetFile(p).metadata.num_rows
                n_bytes += p.stat().st_size
            # Emit only the shard COUNT, not the full cell list: the worker
            # reads shards with `missingOk` rather than pre-filtering against
            # an existence set, so the per-combo lists (up to ~78k cells ×
            # several combos = ~9 MB) served no consumer. The top-level
            # `shard_cells` (raw r{shard_res} cells) is kept below.
            pyramid_combos.append({
                'shard_res': s_res,
                'data_res': d_res,
                'shard_count': len(shards),
                'row_count': n_rows,
                'byte_size': n_bytes,
            })
            row_counts[f'pyramid_s{s_res}_r{d_res}'] = n_rows

    # Consolidated layout has no `s*_r*` dirs, but the client's `pickCover`
    # still reads `pyramid_combos` as its viewport-cover granularity menu:
    # per data_res it picks a shard_res, builds a cover at that res, and sends
    # those cells. The worker ignores `shard_res` (it serves any
    # (shard_res, data_res) from the one r4-sharded level via row-group
    # pruning), so this is purely a client-side cover-sizing menu. Synthesize
    # it — the exact granularities the old fine tiers advertised, so cover
    # counts stay within the client's COVER_MAX_SHARDS — for every level.
    if not pyramid_combos:
        cover_menu = {
            6: (2, 3), 7: (2, 3, 4), 8: (3, 4, 5), 9: (4, 5, 6), 10: (5, 6, 7),
            11: (6, 7, 8), 12: (7, 8, 9), 13: (8, 9), 14: (9,), 15: (7, 8),
        }
        for d_res in levels:
            for s_res in cover_menu.get(d_res, ()):
                pyramid_combos.append({'shard_res': s_res, 'data_res': d_res})

    sha = _git_sha()
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    manifest = {
        'schema_version': SCHEMA_VERSION,
        'data_version': f'{ts}-{sha}',
        'base_res': base_res,
        'shard_res': shard_res,
        'pyramid_levels': levels,
        'pyramid_combos': pyramid_combos,
        'year_range': [min(years_seen), max(years_seen)] if years_seen else None,
        'shard_cells': raw_shards,
        'row_counts': row_counts,
    }
    out_path = out_dir / 'manifest.json'
    out_path.write_text(json.dumps(manifest, indent=2) + '\n')
    err(f'Wrote {out_path}')
    err(f'  raw rows: {raw_total:,}, shards: {len(raw_shards)}, year_range: {manifest["year_range"]}')
    if pyramid_combos:
        err(f'  combos (client cover menu): {len(pyramid_combos)}')
        for c in pyramid_combos:
            if 'shard_count' in c:  # measured from on-disk s*_r* dirs (legacy layout)
                err(f'    s{c["shard_res"]}/r{c["data_res"]}: {c["shard_count"]:,} shards, {c["row_count"]:,} rows, {c["byte_size"]/1024/1024:.1f} MB')
            else:  # synthesized menu (consolidated layout)
                err(f'    s{c["shard_res"]}/r{c["data_res"]}')


@cells.command('db')
@click.option('-b', '--base-res', type=int, default=None, help='Raw base resolution/level (default: auto-detect from raw dir)')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing output .db')
@click.option('-g', '--grid', type=click.Choice(['h3', 's2']), default='h3', help='Cell grid (default: h3)')
@click.option('-l', '--levels', default=None, help=f'Comma-separated data resolutions (default: h3={",".join(map(str, CELLS_DB_LEVELS_DEFAULT))}, s2={",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-S', '--sld-path', type=click.Path(path_type=Path), default=None, help='sld parquet with labels (default: <out-dir>/hex-sld.parquet for h3, s2-sld.parquet for s2)')
def cells_db(base_res: int | None, force: bool, grid: str, levels: str | None, out_dir: Path, sld_path: Path | None):
    """Roll the raw index up to one row per cell (all years) → SQLite for D1.

    `--grid s2` builds `cells-s2.db` with `cells_s2_l{level}(cellid TEXT PK, ...)`
    from `raw/s2_l{base}` (see specs/s2-pyramid.md); default `--grid h3` builds
    `cells.db` below.
    """
    if grid == 's2':
        return _cells_db_s2(base_res, force, levels, out_dir, sld_path)
    if levels is None:
        levels = ','.join(map(str, CELLS_DB_LEVELS_DEFAULT))
    return _cells_db_h3(base_res, force, levels, out_dir, sld_path)


def _cells_db_h3(base_res: int | None, force: bool, levels: str, out_dir: Path, sld_path: Path | None):
    """Roll the raw H3 index up to one row per cell (all years) → SQLite for D1.

    Aggregates `raw/h3_r{base_res}/*.parquet` (per-crash) directly — via the
    duckdb `h3` extension's `h3_cell_to_parent` — into
    `cells_r{res}(h3 PK, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs,
    fatal_years, sld_name, cross_sld_name, mun, county)` for each requested res,
    the default (all-years, all-severity) `/v1/cells` fast path. Building from
    raw (not the pyramid) keeps the whole rollup memory-bounded — duckdb streams
    each res's group-by — so it runs in CI where the pyramid build OOMs. The
    per-res counts match `_build_pyramid_level` exactly (verified row-for-row
    against the pyramid-derived output).

    `h3` is the INTEGER PRIMARY KEY (rowid) so the worker's
    `WHERE h3 BETWEEN lo AND hi` range scans are B-tree-fast. Year- or
    severity-filtered queries still read the parquet pyramid (this table has no
    year/severity dimension). Labels come from a `LEFT JOIN` on `hex-sld`
    (keyed on the cell's own h3 for `res <= SLD_MAX_RES`, else its
    r{SLD_MAX_RES} ancestor — the same fallback `_build_pyramid_level` bakes in).
    `fatal_years` is the sorted-distinct set of years with a fatal. The build is
    deterministic → the D1 exact-diff import writes only genuinely-changed cells.
    """
    import sqlite3
    import duckdb
    level_ints = [int(x) for x in levels.split(',') if x.strip()]
    if base_res is None:
        raw_root = out_dir / 'raw'
        cand = sorted(
            int(p.name[len('h3_r'):]) for p in raw_root.glob('h3_r*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw index found under {raw_root}; run `compute cells raw` first')
            raise SystemExit(1)
        base_res = cand[-1]
    raw_glob = out_dir / 'raw' / f'h3_r{base_res}' / '*.parquet'
    if sld_path is None:
        sld_path = out_dir / 'hex-sld.parquet'
    h3col = f'h3_r{base_res}'
    out = out_dir / 'cells.db'
    if out.exists():
        if not force:
            err(f'{out} exists; use -f to overwrite')
            raise SystemExit(1)
        out.unlink()
    out.parent.mkdir(parents=True, exist_ok=True)

    # 1. Typed empty tables — `h3 INTEGER PRIMARY KEY` aliases the rowid, so
    #    range scans need no secondary index. `.schema` carries this into D1.
    s = sqlite3.connect(out)
    counts_ddl = ', '.join(f'{c} INTEGER NOT NULL' for c in CELLS_DB_COUNT_COLS)
    labels_ddl = ', '.join(f'{c} TEXT' for c in SLD_COLS)
    for r in level_ints:
        s.execute(f'CREATE TABLE cells_r{r} (h3 INTEGER PRIMARY KEY, {counts_ddl}, fatal_years TEXT, {labels_ddl})')
    s.commit()
    s.close()

    # 2. Aggregate raw → each res via duckdb (streams the group-by; `h3`
    #    extension supplies `h3_cell_to_parent`). `hex-sld` (string h3) is
    #    interned to int64 once, then LEFT-JOINed per res.
    con = duckdb.connect()
    con.execute('INSTALL h3 FROM community; LOAD h3')
    con.execute(f"ATTACH '{out}' AS d (TYPE SQLITE)")
    con.execute(f"""
      CREATE TEMP TABLE sld AS
      SELECT CAST(h3_string_to_h3(h3) AS BIGINT) AS h3, {', '.join(SLD_COLS)}
      FROM read_parquet('{sld_path}')
    """)
    insert_cols = ', '.join(['h3', *CELLS_DB_COUNT_COLS, 'fatal_years', *SLD_COLS])
    agg_cols = ', '.join(f'a.{c}' for c in CELLS_DB_COUNT_COLS)
    sld_sel = ', '.join(f's.{c}' for c in SLD_COLS)
    for r in level_ints:
        t0 = time()
        con.execute(f"""
          INSERT INTO d.cells_r{r} ({insert_cols})
          WITH agg AS (
            SELECT
              CAST(h3_cell_to_parent(CAST({h3col} AS UBIGINT), {r}) AS BIGINT) AS h3,
              count(*) FILTER (WHERE severity = 'f') AS n_fatal,
              coalesce(sum(pi), 0) AS n_inj_ped,
              coalesce(sum(greatest(coalesce(ti, 0) - coalesce(pi, 0), 0)), 0) AS n_inj_other,
              count(*) FILTER (WHERE severity = 'p') AS n_pdo,
              coalesce(sum(tv), 0) AS n_vehs,
              nullif(array_to_string(list_sort(list_distinct(list(year) FILTER (WHERE severity = 'f'))), ','), '') AS fatal_years
            FROM read_parquet('{raw_glob}')
            GROUP BY 1
          )
          SELECT a.h3, {agg_cols}, a.fatal_years, {sld_sel}
          FROM agg a
          LEFT JOIN sld s ON s.h3 = CAST(h3_cell_to_parent(CAST(a.h3 AS UBIGINT), LEAST({r}, {SLD_MAX_RES})) AS BIGINT)
        """)
        n = con.execute(f'SELECT count(*) FROM d.cells_r{r}').fetchone()[0]
        err(f'  r{r}: {n:,} cells ({time() - t0:.1f}s)')
    con.close()

    # 3. Compact so the on-disk size (and DVC md5) is stable run-to-run.
    s = sqlite3.connect(out)
    s.execute('VACUUM')
    s.close()
    err(f'Wrote {out} ({out.stat().st_size / 1e6:.1f} MB, res {level_ints}, base r{base_res})')


def _cells_db_s2(base_level: int | None, force: bool, levels: str | None, out_dir: Path, sld_path: Path | None):
    """Roll the raw S2 index up to one row per cell (all years) → `cells-s2.db`.

    Mirrors `_cells_db_h3` but S2: aggregates `raw/s2_l{base}/*.parquet` (each
    crash's uint64 S2 cell id at the base level) into
    `cells_s2_l{level}(cellid TEXT PRIMARY KEY, n_fatal, n_inj_ped, n_inj_other,
    n_pdo, n_vehs, fatal_years, sld_name, cross_sld_name, mun, county)`. Parent
    ids + tokens are derived in-SQL via `njdot.s2.parent_sql`/`token_sql`
    (UBIGINT bit-math validated == s2sphere == nodes2ts, tests/test_s2.py), so
    the group-by streams and stays memory-bounded. `cellid` is a TEXT PK
    (S2 tokens are strings by design — no int64 encoding as with h3); its
    BINARY-collation order matches S2's Hilbert order, so the worker's
    `WHERE cellid BETWEEN lo AND hi` range scan is B-tree-fast. Labels are a
    `LEFT JOIN` on `s2-sld` keyed on the cell's own token (baked at every level).
    """
    import sqlite3
    import duckdb
    if levels is None:
        levels = ','.join(map(str, S2_LEVELS_DEFAULT))
    level_ints = [int(x) for x in levels.split(',') if x.strip()]
    if base_level is None:
        raw_root = out_dir / 'raw'
        cand = sorted(
            int(p.name[len('s2_l'):]) for p in raw_root.glob('s2_l*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw S2 index under {raw_root}; run `compute cells raw --grid s2` first')
            raise SystemExit(1)
        base_level = cand[-1]
    raw_glob = out_dir / 'raw' / f's2_l{base_level}' / '*.parquet'
    s2col = f's2_l{base_level}'
    if sld_path is None:
        sld_path = out_dir / 's2-sld.parquet'
    have_sld = Path(sld_path).exists()
    out = out_dir / 'cells-s2.db'
    if out.exists():
        if not force:
            err(f'{out} exists; use -f to overwrite')
            raise SystemExit(1)
        out.unlink()
    out.parent.mkdir(parents=True, exist_ok=True)

    # 1. Typed empty tables — `cellid TEXT PRIMARY KEY` (a unique index whose
    #    BINARY order == Hilbert order). `.schema` carries this into D1.
    s = sqlite3.connect(out)
    counts_ddl = ', '.join(f'{c} INTEGER NOT NULL' for c in CELLS_DB_COUNT_COLS)
    labels_ddl = ', '.join(f'{c} TEXT' for c in SLD_COLS)
    for lv in level_ints:
        s.execute(f'CREATE TABLE cells_s2_l{lv} (cellid TEXT PRIMARY KEY, {counts_ddl}, fatal_years TEXT, {labels_ddl})')
    s.commit()
    s.close()

    # 2. Aggregate raw → each level via duckdb. Group by the integer parent id
    #    (cheaper than the token string), format the token once per unique
    #    cell, then LEFT-JOIN labels on that token.
    con = duckdb.connect()
    con.execute(f"ATTACH '{out}' AS d (TYPE SQLITE)")
    if have_sld:
        con.execute(f"CREATE TEMP TABLE sld AS SELECT cellid, {', '.join(SLD_COLS)} FROM read_parquet('{sld_path}')")
        err(f'  sld: {con.execute("SELECT count(*) FROM sld").fetchone()[0]:,} labelled cells from {sld_path}')
    else:
        err(f'  no s2-sld at {sld_path}; label columns will be NULL')
    insert_cols = ', '.join(['cellid', *CELLS_DB_COUNT_COLS, 'fatal_years', *SLD_COLS])
    agg_cols = ', '.join(f't.{c}' for c in CELLS_DB_COUNT_COLS)
    if have_sld:
        sld_sel = ', '.join(f's.{c}' for c in SLD_COLS)
        join = 'LEFT JOIN sld s ON s.cellid = t.cellid'
    else:
        sld_sel = ', '.join('NULL' for _ in SLD_COLS)
        join = ''
    for lv in level_ints:
        t0 = time()
        parent = s2.parent_sql(f'CAST({s2col} AS UBIGINT)', lv)
        con.execute(f"""
          INSERT INTO d.cells_s2_l{lv} ({insert_cols})
          WITH agg AS (
            SELECT
              {parent} AS pid,
              count(*) FILTER (WHERE severity = 'f') AS n_fatal,
              coalesce(sum(pi), 0) AS n_inj_ped,
              coalesce(sum(greatest(coalesce(ti, 0) - coalesce(pi, 0), 0)), 0) AS n_inj_other,
              count(*) FILTER (WHERE severity = 'p') AS n_pdo,
              coalesce(sum(tv), 0) AS n_vehs,
              nullif(array_to_string(list_sort(list_distinct(list(year) FILTER (WHERE severity = 'f'))), ','), '') AS fatal_years
            FROM read_parquet('{raw_glob}')
            GROUP BY 1
          ), t AS (
            SELECT {s2.token_sql('pid')} AS cellid, * EXCLUDE (pid) FROM agg
          )
          SELECT t.cellid, {agg_cols}, t.fatal_years, {sld_sel}
          FROM t
          {join}
        """)
        n = con.execute(f'SELECT count(*) FROM d.cells_s2_l{lv}').fetchone()[0]
        err(f'  l{lv}: {n:,} cells ({time() - t0:.1f}s)')
    con.close()

    # 3. Compact so the on-disk size (and DVC md5) is stable run-to-run.
    s = sqlite3.connect(out)
    s.execute('VACUUM')
    s.close()
    err(f'Wrote {out} ({out.stat().st_size / 1e6:.1f} MB, levels {level_ints}, base l{base_level}, sld={have_sld})')


@cells.command('sld')
@click.option('-b', '--base-level', type=int, default=None, help='Raw S2 base level (default: auto-detect from raw/s2_l* dir)')
@click.option('-g', '--grid', type=click.Choice(['s2']), default='s2', help='Cell grid (only s2; h3 uses `njdot export_hex_sld`)')
@click.option('-l', '--levels', default=None, help=f'Comma-separated levels to label (default: {",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('--mp-path', default='njdot/data/nj_mp_tenths.parquet', show_default=True)
@click.option('--muni-path', default='www/public/Municipal_Boundaries_of_NJ.geojson', show_default=True)
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
def cells_sld(base_level: int | None, grid: str, levels: str | None, mp_path: str, muni_path: str, out_dir: Path):
    """Build `s2-sld.parquet` — road/muni labels per S2 cell token.

    S2 analog of `njdot export_hex_sld`: enumerate every S2 cell (at the given
    levels) containing a geocoded crash, compute its centroid, and reuse
    `export_hex_sld`'s grid-agnostic nearest-MP + point-in-polygon lookups.
    Output `cellid | sld_name | cross_sld_name | mun | county`, keyed by token
    so `cells db`/`pyramid --grid s2` join on the cell's own token."""
    import duckdb
    import pandas as pd
    from njdot.cli.export_hex_sld import _muni_county, _nearest_mp
    level_ints = [int(x) for x in (levels or ','.join(map(str, S2_LEVELS_DEFAULT))).split(',') if x.strip()]
    if base_level is None:
        raw_root = out_dir / 'raw'
        cand = sorted(
            int(p.name[len('s2_l'):]) for p in raw_root.glob('s2_l*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw S2 index under {raw_root}; run `compute cells raw --grid s2` first')
            raise SystemExit(1)
        base_level = cand[-1]
    raw_glob = out_dir / 'raw' / f's2_l{base_level}' / '*.parquet'

    err(f'Enumerating distinct l{base_level} cells...')
    t0 = time()
    con = duckdb.connect()
    l16_ids = con.execute(
        f"SELECT DISTINCT s2_l{base_level} AS id FROM read_parquet('{raw_glob}')"
    ).df()['id'].to_numpy().astype(np.uint64)
    err(f'  {len(l16_ids):,} distinct base cells ({time() - t0:.1f}s)')

    # Every cell at level L is a parent of some base cell → union of parent
    # sets across levels is the full cell set to label.
    err(f'Deriving distinct cells across levels {level_ints}...')
    t0 = time()
    all_ids: set[int] = set()
    for lv in level_ints:
        all_ids.update(int(x) for x in np.unique(s2.parent_id(l16_ids, lv)))
    ids = sorted(all_ids)
    err(f'  {len(ids):,} distinct cells ({time() - t0:.1f}s)')

    err(f'Computing centroids ({len(ids):,} cells)...')
    t0 = time()
    latlngs = [s2.id_to_latlng(i) for i in ids]
    centroids = pd.DataFrame({
        'h3': [s2.id_to_token(i) for i in ids],   # 'h3' col name reused by the lookups
        'lat': [ll[0] for ll in latlngs],
        'lon': [ll[1] for ll in latlngs],
    })
    err(f'  {time() - t0:.1f}s')

    err(f'Loading MP index: {mp_path}')
    mp = pd.read_parquet(mp_path)
    err(f'Nearest-MP lookup ({len(centroids):,} centroids → {len(mp):,} MPs)...')
    sld = _nearest_mp(centroids, mp)
    err(f'Point-in-polygon lookup ({len(centroids):,} centroids)...')
    mc = _muni_county(centroids, muni_path)

    enriched = sld.merge(mc, on='h3', how='left').rename(columns={'h3': 'cellid'})
    out_cols = ['cellid', *SLD_COLS]
    out_path = out_dir / 's2-sld.parquet'
    enriched[out_cols].to_parquet(out_path, index=False)
    n_mun = (enriched['mun'].fillna('') != '').sum()
    err(f'Wrote {out_path} ({len(enriched):,} cells, {n_mun:,} with muni)')


@cells.command('push')
@click.option('-b', '--bucket', default=R2_BUCKET_DEFAULT, help=f'R2 bucket (default: {R2_BUCKET_DEFAULT})')
@click.option('-D', '--no-delete', is_flag=True, help='Additive push (skip `--delete`). Use when local lacks legacy data still needed in R2.')
@click.option('-n', '--dry-run', is_flag=True, help='Show what would be uploaded without uploading')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-p', '--prefix', default=R2_PREFIX_DEFAULT, help=f'Bucket prefix (default: {R2_PREFIX_DEFAULT})')
@click.option('-q', '--quiet', is_flag=True, help='`--only-show-errors` (suppress per-file progress; huge with 100k+ shards)')
@click.option('--profile', default=R2_PROFILE_DEFAULT, help=f'AWS profile for R2 (default: {R2_PROFILE_DEFAULT})')
def cells_push(bucket: str, no_delete: bool, dry_run: bool, out_dir: Path, prefix: str, quiet: bool, profile: str):
    """Mirror `out_dir` to s3://{bucket}/{prefix}/ for the worker (excludes .dvc artifacts)."""
    s3_uri = f's3://{bucket}/{prefix}/'
    cmd = [
        'aws', 's3', 'sync', f'{out_dir}/', s3_uri,
        '--exclude', '*.dvc',
        '--exclude', '.gitignore',
        # cells.db is a D1 import source (loaded via `d1-import.sh`), not
        # worker-served from R2 — keep it out of the bucket mirror.
        '--exclude', '*.db',
    ]
    if not no_delete:
        cmd.append('--delete')
    if dry_run:
        cmd.append('--dryrun')
    if quiet:
        cmd.append('--only-show-errors')
    env = {**os.environ, 'AWS_PROFILE': profile}
    err(f'$ AWS_PROFILE={profile} {" ".join(cmd)}')
    subprocess.run(cmd, env=env, check=True)
