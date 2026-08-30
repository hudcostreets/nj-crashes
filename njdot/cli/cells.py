"""Build S2-tagged + sharded crash data for the cells API (#52).

Phases produce, under {out_dir} (default `data/cells/`):

    raw/s2_l{base_level}/{shard_token}.parquet    # Phase 1: one per l{shard_level} parent
    s2-sld.parquet                                # Phase 2: per-cell road/muni labels
    s2_pyramid/s2_l{N}/{shard_token}.parquet      # Phase 3: per-level rollups (N in S2_LEVELS)
    cells-s2.db                                   # Phase 4: all-years rollup → D1
    manifest.json

`shard_token` is the S2 cell's token at `shard_level` (default l4 — NJ is two
of them). Within each raw shard, rows are sorted by `s2_l{base_level}`
(uint64) so parquet row-group min/max statistics give the worker
tree-structured pruning at any coarser level; token order matches id order,
so the same sort serves the D1 `cellid BETWEEN` scans. Pyramid shards sort by
`(cellid, year)`.

S2 replaced H3 here — see specs/s2-pyramid.md and specs/h3-removal.md. Also
specs/cfw-cells-pipeline.md and specs/cfw-cells-api.md.
"""
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from time import time

import click
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nj_crashes.utils.log import err
from njdot import s2
from njdot.cli.base import compute
from njdot.map_base import _build_base
from njdot.load import load_crashes_with_aashto
from njdot.paths import ROOT_DIR


# Subset of crashes.parquet that `_build_base` needs (mirrors export_map_v2).
# Reading a column subset avoids a pyarrow "Unknown error: Wrapping" exception
# when the full per-table schema round-trips through pandas.
MAP_INPUT_COLS = [
    'year', 'dt', 'cc', 'mc', 'case', 'severity',
    'tk', 'ti', 'pk', 'pi', 'tv',
    'olat', 'olon', 'ilat', 'ilon',
    'road', 'cross_street', 'route', 'sri', 'mp',
]


TOPK_DEFAULT = 10
SCHEMA_VERSION = 5

SLD_COLS = ('sld_name', 'cross_sld_name', 'mun', 'county')

OUT_DIR_DEFAULT = Path(ROOT_DIR) / 'data' / 'cells'
CELLS_DB_COUNT_COLS = ('n_fatal', 'n_inj_ped', 'n_inj_other', 'n_pdo', 'n_vehs')

# S2 steps 4x area / 2x linear per level (vs H3's 7x / 2.65x), so the same
# zoom span spans ~1.4x more levels. The raw index caches each crash's cell
# id at `S2_BASE_LEVEL` (the finest data level); every coarser level's cell
# is derived by UBIGINT bit-math (`njdot.s2.parent_sql`), byte-identical to
# both `s2sphere` and the client's `nodes2ts` (see `tests/test_s2.py`).
S2_BASE_LEVEL_DEFAULT = 21       # finest data level; raw stores cell id here
S2_SHARD_LEVEL_DEFAULT = 4       # NJ is two level-4 cells (`89b`, `89d`)
# Levels rolled into cells-s2.db / the pyramid. l4-l5 are near-empty (NJ is
# ~15 cells at l4) but cheap, and the statewide viewport picks them; l21
# (~3.75 m) is the base. Phase 6 took the base 16 → 18, phase 7 18 → 19, and
# phase 8 19 → 21: the picker lands on l21 at street zoom, where an S2 cell
# finally matches H3 r14 (~4 m) instead of rendering ~5× coarser. l22+ is
# point-mode territory (~1 crash/cell), so aggregation stops paying for itself.
S2_LEVELS_DEFAULT = tuple(range(4, 22))
R2_BUCKET_DEFAULT = 'nj-crashes'
R2_PREFIX_DEFAULT = 'cells'
R2_PROFILE_DEFAULT = 'cf'



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
    """Build S2-tagged + sharded crash data for the cells API."""


@cells.command('raw')
@click.option('-b', '--base-level', type=int, default=S2_BASE_LEVEL_DEFAULT, show_default=True, help='Base S2 level; raw stores each crash\'s cell id here')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing output directory')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT, help=f'Output root (default: {OUT_DIR_DEFAULT})')
@click.option('-s', '--shard-level', type=int, default=S2_SHARD_LEVEL_DEFAULT, show_default=True, help='S2 level to shard files by')
def cells_raw(base_level: int, force: bool, out_dir: Path, shard_level: int):
    """Phase 1: tag crashes with an S2 cell id at `base_level`, sort, shard by
    the `shard_level` parent (see specs/s2-pyramid.md)."""
    base_res, shard_res = base_level, shard_level
    cell_name = f's2_l{base_res}'
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
    err(f'Computing {cell_name} for {n_geo:,} rows...')
    t0 = time()
    cells = s2.latlng_to_id(lat, lon, base_res)          # uint64
    shard_arr = s2.parent_id(cells, shard_res)           # uint64
    shard_name = lambda v: s2.id_to_token(int(v))
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
            err(f'No raw S2 index under {raw_root}; run `compute cells raw` first')
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
        err(f'No raw S2 shards in {raw_dir}; run `compute cells raw` first')
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
@click.option('-b', '--base-level', type=int, default=None, help='Raw S2 base level (default: auto-detect from raw/s2_l* dirs)')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing pyramid output')
@click.option('-k', '--topk', type=int, default=TOPK_DEFAULT, help=f'topK most-recent crashes per cell-year (default: {TOPK_DEFAULT})')
@click.option('-l', '--levels', default=None, help=f'Comma-separated pyramid levels (default: {",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-r', '--row-group-size', type=int, default=4096, help='Parquet row-group size (smaller -> finer worker range pruning; default: 4096)')
@click.option('-s', '--shard-level', type=int, default=None, help=f'S2 level to shard files by (default: {S2_SHARD_LEVEL_DEFAULT})')
@click.option('-S', '--sld-path', type=click.Path(path_type=Path), default=None, help='sld parquet to bake into rows, or "" to skip (default: <out-dir>/s2-sld.parquet)')
def cells_pyramid(base_level: int | None, force: bool, topk: int, levels: str | None, out_dir: Path, row_group_size: int, shard_level: int | None, sld_path: Path | None):
    """Phase 3: per-(cell, year) rollups -> counts + topK + sld, sharded parquet.

    One `s2_pyramid/s2_l{level}/{token}.parquet` per shard, cellid-sorted with
    `row_group_size` row-groups so the worker prunes to viewport row-groups by
    cell range. See specs/s2-pyramid.md."""
    return _cells_pyramid_s2(base_level, force, topk, levels, out_dir, row_group_size, shard_level, sld_path)


@cells.command('manifest')
@click.option('-b', '--base-level', type=int, default=None, help='Raw S2 base level (default: auto-detect from raw/s2_l* dirs)')
@click.option('-l', '--levels', default=None, help=f'Comma-separated pyramid levels (default: {",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-s', '--shard-level', type=int, default=S2_SHARD_LEVEL_DEFAULT, show_default=True, help='S2 level the raw/pyramid files are sharded by')
def cells_manifest(base_level: int | None, levels: str | None, out_dir: Path, shard_level: int):
    """Walk on-disk shards and emit `manifest.json`.

    The worker reads two fields from this: `data_version` (its ETag salt, so a
    fresh push invalidates client + edge caches) and `year_range` (the default
    when a request omits `years`, and the "covers all years" test that routes a
    request to the D1 rollup instead of the parquet pyramid). Everything else is
    for humans and for `/v1/manifest` debugging.
    """
    raw_root = out_dir / 'raw'
    if base_level is None:
        cand = sorted(
            int(p.name[len('s2_l'):]) for p in raw_root.glob('s2_l*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw S2 index under {raw_root}; run `compute cells raw` first')
            raise SystemExit(1)
        base_level = cand[-1]
    level_ints = sorted(int(x) for x in (levels or ','.join(map(str, S2_LEVELS_DEFAULT))).split(',') if x.strip())
    raw_dir = raw_root / f's2_l{base_level}'
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
        f = pq.ParquetFile(raw_dir / f'{shard}.parquet')
        raw_total += f.metadata.num_rows
        # Pull year range cheaply from RG stats.
        idx = f.schema_arrow.get_field_index('year')
        if idx >= 0:
            for rg_i in range(f.metadata.num_row_groups):
                stats = f.metadata.row_group(rg_i).column(idx).statistics
                if stats and stats.has_min_max:
                    years_seen.add(int(stats.min))
                    years_seen.add(int(stats.max))
    row_counts['raw'] = raw_total

    built_levels: list[int] = []
    for level in level_ints:
        pdir = out_dir / 's2_pyramid' / f's2_l{level}'
        if not pdir.exists():
            continue
        paths = sorted(pdir.glob('*.parquet'))
        if not paths:
            continue
        built_levels.append(level)
        row_counts[f's2_l{level}'] = sum(pq.ParquetFile(p).metadata.num_rows for p in paths)

    sha = _git_sha()
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    manifest = {
        'schema_version': SCHEMA_VERSION,
        'data_version': f'{ts}-{sha}',
        'grid': 's2',
        'base_level': base_level,
        'shard_level': shard_level,
        'pyramid_levels': built_levels,
        'year_range': [min(years_seen), max(years_seen)] if years_seen else None,
        'shard_cells': raw_shards,
        'row_counts': row_counts,
    }
    out_path = out_dir / 'manifest.json'
    out_path.write_text(json.dumps(manifest, indent=2) + '\n')
    err(f'Wrote {out_path}')
    err(f'  raw rows: {raw_total:,}, shards: {len(raw_shards)}, year_range: {manifest["year_range"]}')
    err(f'  pyramid levels built: {built_levels}')


@cells.command('db')
@click.option('-b', '--base-level', type=int, default=None, help='Raw S2 base level (default: auto-detect from raw/s2_l* dirs)')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing output .db')
@click.option('-l', '--levels', default=None, help=f'Comma-separated data levels (default: {",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-S', '--sld-path', type=click.Path(path_type=Path), default=None, help='sld parquet with labels (default: <out-dir>/s2-sld.parquet)')
def cells_db(base_level: int | None, force: bool, levels: str | None, out_dir: Path, sld_path: Path | None):
    """Phase 4: roll the raw index up to one row per cell (all years) -> SQLite.

    Builds `cells-s2.db` with `cells_s2_l{level}(cellid TEXT PK, ...)` from
    `raw/s2_l{base}` — the source for the `CELLS_S2_DB` D1 binding that serves
    every all-years `/v1/cells` request (see specs/s2-pyramid.md).
    """
    return _cells_db_s2(base_level, force, levels, out_dir, sld_path)


def _cells_db_s2(base_level: int | None, force: bool, levels: str | None, out_dir: Path, sld_path: Path | None):
    """Roll the raw S2 index up to one row per cell (all years) → `cells-s2.db`.

    Aggregates `raw/s2_l{base}/*.parquet` (each
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
            err(f'No raw S2 index under {raw_root}; run `compute cells raw` first')
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
    #    cell, then LEFT-JOIN labels on that token. The `ORDER BY cellid` on the
    #    INSERT is load-bearing for reproducibility, not cosmetic: duckdb's
    #    parallel hash-aggregate emits groups in a non-deterministic order, and
    #    these are rowid tables (`cellid TEXT PRIMARY KEY`, not WITHOUT ROWID),
    #    so insertion order becomes the physical rowid layout — and VACUUM
    #    (step 3) copies rows in rowid order, preserving it. Ordering the insert
    #    by the PK pins that layout, making the file byte-identical run-to-run.
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
          ORDER BY t.cellid
        """)
        n = con.execute(f'SELECT count(*) FROM d.cells_s2_l{lv}').fetchone()[0]
        err(f'  l{lv}: {n:,} cells ({time() - t0:.1f}s)')
    con.close()

    # 3. Compact so the on-disk size is minimal (VACUUM alone does NOT make the
    #    md5 stable — it preserves rowid order; the step-2 `ORDER BY` does that).
    s = sqlite3.connect(out)
    s.execute('VACUUM')
    s.close()
    err(f'Wrote {out} ({out.stat().st_size / 1e6:.1f} MB, levels {level_ints}, base l{base_level}, sld={have_sld})')


@cells.command('sld')
@click.option('-b', '--base-level', type=int, default=None, help='Raw S2 base level (default: auto-detect from raw/s2_l* dir)')
@click.option('-l', '--levels', default=None, help=f'Comma-separated levels to label (default: {",".join(map(str, S2_LEVELS_DEFAULT))})')
@click.option('--mp-path', default='njdot/data/nj_mp_tenths.parquet', show_default=True)
@click.option('--muni-path', default='www/public/Municipal_Boundaries_of_NJ.geojson', show_default=True)
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
def cells_sld(base_level: int | None, levels: str | None, mp_path: str, muni_path: str, out_dir: Path):
    """Phase 2: build `s2-sld.parquet` -- road/muni labels per S2 cell token.

    Enumerate every S2 cell (at the given levels) containing a geocoded crash,
    compute its centroid, and run the nearest-milepost + point-in-polygon
    lookups in `njdot.sld`. Output `cellid | sld_name | cross_sld_name | mun |
    county`, keyed by token so `cells db` / `cells pyramid` join on the cell's
    own token."""
    import duckdb
    import pandas as pd
    from njdot.sld import muni_county, nearest_mp
    level_ints = [int(x) for x in (levels or ','.join(map(str, S2_LEVELS_DEFAULT))).split(',') if x.strip()]
    if base_level is None:
        raw_root = out_dir / 'raw'
        cand = sorted(
            int(p.name[len('s2_l'):]) for p in raw_root.glob('s2_l*')
            if p.is_dir() and any(p.glob('*.parquet'))
        )
        if not cand:
            err(f'No raw S2 index under {raw_root}; run `compute cells raw` first')
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
        'cell': [s2.id_to_token(i) for i in ids],
        'lat': [ll[0] for ll in latlngs],
        'lon': [ll[1] for ll in latlngs],
    })
    err(f'  {time() - t0:.1f}s')

    err(f'Loading MP index: {mp_path}')
    mp = pd.read_parquet(mp_path)
    err(f'Nearest-MP lookup ({len(centroids):,} centroids → {len(mp):,} MPs)...')
    sld = nearest_mp(centroids, mp)
    err(f'Point-in-polygon lookup ({len(centroids):,} centroids)...')
    mc = muni_county(centroids, muni_path)

    enriched = sld.merge(mc, on='cell', how='left').rename(columns={'cell': 'cellid'})
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
        # Both the top-level ignore and the per-dir ones DVX generates
        # alongside each tracked out (e.g. `raw/.gitignore`); `--exclude
        # .gitignore` alone only matches the former.
        '--exclude', '.gitignore',
        '--exclude', '*/.gitignore',
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
