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
from njdot.cli.base import compute
from njdot.cli.export_map_data import _build_base
from njdot.paths import CRASHES_PQT


BASE_RES_DEFAULT = 14
SHARD_RES_DEFAULT = 4
PYRAMID_LEVELS_DEFAULT = (6, 7, 8, 9, 10, 11, 12, 13)
TOPK_DEFAULT = 10
SCHEMA_VERSION = 4

OUT_DIR_DEFAULT = Path('data/cells')
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
@click.option('-b', '--base-res', type=int, default=BASE_RES_DEFAULT, help=f'H3 base resolution (default: {BASE_RES_DEFAULT})')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing output directory')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT, help=f'Output root (default: {OUT_DIR_DEFAULT})')
@click.option('-s', '--shard-res', type=int, default=SHARD_RES_DEFAULT, help=f'H3 shard resolution (default: {SHARD_RES_DEFAULT})')
def cells_raw(base_res: int, force: bool, out_dir: Path, shard_res: int):
    """Phase 1: tag crashes with h3_r{base_res}, sort, shard by r{shard_res} parent."""
    raw_dir = out_dir / 'raw' / f'h3_r{base_res}'
    if raw_dir.exists() and any(raw_dir.iterdir()):
        if not force:
            err(f'{raw_dir} non-empty; use -f/--force to overwrite')
            return
        for p in raw_dir.glob('*.parquet'):
            p.unlink()
    raw_dir.mkdir(parents=True, exist_ok=True)

    err(f'Loading {CRASHES_PQT}...')
    df = pd.read_parquet(CRASHES_PQT)
    n_total = len(df)
    err(f'  {n_total:,} rows')

    err('Computing effective lat/lon (via _build_base)...')
    base = _build_base(df, keep_severities=set())
    n_geo = len(base)
    n_drop = n_total - n_geo
    err(f'  {n_geo:,} rows with lat/lon (dropped {n_drop:,} ungeocoded, {n_drop / n_total:.1%})')

    err('Re-attaching `year` from source...')
    base['year'] = df.loc[base.index, 'year'].astype('int16')

    err(f'Computing h3_r{base_res} for {n_geo:,} rows...')
    t0 = time()
    h3_col = _h3_int_col(base['lat'].to_numpy(), base['lon'].to_numpy(), base_res)
    err(f'  {time() - t0:.1f}s')
    h3_name = f'h3_r{base_res}'
    base[h3_name] = h3_col

    err(f'Computing shard_cell at r{shard_res}...')
    t0 = time()
    shard_int = _parent_int_col(h3_col, shard_res)
    n_shards = len(np.unique(shard_int))
    err(f'  {time() - t0:.1f}s, {n_shards} shards')
    base['__shard'] = shard_int

    err('Sorting by (shard, h3)...')
    base = base.sort_values(['__shard', h3_name], kind='mergesort')

    err('Writing shards (zstd, row_group_size=20000)...')
    counts: dict[str, int] = {}
    t0 = time()
    for shard, sub in base.groupby('__shard', sort=False):
        out = sub.drop(columns='__shard')
        shard_hex = h3.int_to_str(int(shard))
        path = raw_dir / f'{shard_hex}.parquet'
        out.to_parquet(path, row_group_size=20_000, index=False, compression='zstd')
        counts[shard_hex] = len(out)
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
) -> dict[str, int]:
    """Aggregate raw rows to a pyramid level and write per-shard parquet files.

    Returns {shard_hex: row_count}. Input `base` must already be sorted by `dt`
    descending — groupby(sort=False).head(topk) then yields the K most-recent
    crashes per (shard, h3_rN, year).
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
    schema = pa.schema([
        (h3_col, pa.int64()),
        ('year', pa.int16()),
        *((c, pa.int32()) for c in (
            'n_crashes', 'n_fatal', 'n_inj', 'n_pdo', 'n_killed', 'n_killed_ped',
            'n_injured', 'n_inj_ped', 'n_inj_other', 'n_vehs',
        )),
        ('topK', pa.list_(topk_struct)),
    ])
    for shard, sub in out.groupby('__shard', sort=False):
        shard_hex = h3.int_to_str(int(shard))
        path = level_dir / f'{shard_hex}.parquet'
        table = pa.Table.from_pandas(sub[cols_out], schema=schema, preserve_index=False)
        pq.write_table(table, path, row_group_size=20_000, compression='zstd')
        counts[shard_hex] = len(sub)
    err(f'    {time() - t0:.1f}s, {len(counts)} shards, {sum(counts.values()):,} rows')
    return counts


@cells.command('pyramid')
@click.option('-b', '--base-res', type=int, default=BASE_RES_DEFAULT)
@click.option('-f', '--force', is_flag=True, help='Overwrite existing pyramid output')
@click.option('-k', '--topk', type=int, default=TOPK_DEFAULT, help=f'topK most-recent crashes per cell-year (default: {TOPK_DEFAULT})')
@click.option('-l', '--levels', default=','.join(map(str, PYRAMID_LEVELS_DEFAULT)), help='Comma-separated pyramid levels')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-s', '--shard-res', type=int, default=SHARD_RES_DEFAULT)
def cells_pyramid(base_res: int, force: bool, topk: int, levels: str, out_dir: Path, shard_res: int):
    """Phase 2: per-resolution rollups (h3_rN, year) → counts + topK."""
    level_ints = [int(x) for x in levels.split(',') if x.strip()]
    pyramid_dir = out_dir / 'pyramid'
    if pyramid_dir.exists() and any(pyramid_dir.iterdir()):
        if not force:
            err(f'{pyramid_dir} non-empty; use -f/--force to overwrite')
            return
        for sub in pyramid_dir.glob('r*'):
            for p in sub.glob('*.parquet'):
                p.unlink()
            sub.rmdir()
    pyramid_dir.mkdir(parents=True, exist_ok=True)

    raw_dir = out_dir / 'raw' / f'h3_r{base_res}'
    raw_paths = sorted(raw_dir.glob('*.parquet'))
    if not raw_paths:
        err(f'No raw shards in {raw_dir}; run `compute cells raw` first')
        raise SystemExit(1)

    err(f'Loading {len(raw_paths)} raw shards from {raw_dir}...')
    t0 = time()
    base = pd.concat([pd.read_parquet(p) for p in raw_paths], ignore_index=True)
    err(f'  {len(base):,} rows in {time() - t0:.1f}s')

    err('Sorting by dt desc (once, for topK head() correctness)...')
    t0 = time()
    base = base.sort_values('dt', ascending=False, kind='mergesort')
    err(f'  {time() - t0:.1f}s')

    h3_base_col = f'h3_r{base_res}'
    for level in level_ints:
        err(f'\n=== Pyramid r{level} ===')
        _build_pyramid_level(base, h3_base_col, level, shard_res, topk, pyramid_dir / f'r{level}')


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


@cells.command('pyramid-combos')
@click.option('-b', '--base-res', type=int, default=BASE_RES_DEFAULT)
@click.option('-c', '--combos', required=True, help='Comma-sep (shard_res, data_res) pairs, e.g. "s5:r9,s6:r10,s7:r11,s8:r12"')
@click.option('-f', '--force', is_flag=True, help='Overwrite existing combo output dirs')
@click.option('-k', '--topk', type=int, default=TOPK_DEFAULT)
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
def cells_pyramid_combos(base_res: int, combos: str, force: bool, topk: int, out_dir: Path):
    """Multi-resolution pyramid: each `(shard_res, data_res)` combo writes
    to `pyramid/s{shard_res}_r{data_res}/{shard_hex}.parquet`. The
    client picks the combo whose viewport-shard count is in target
    range (typically D = data_res - shard_res = 3-5)."""
    combo_list = _parse_combos(combos)
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
    err(f'Loading {len(raw_paths)} raw shards from {raw_dir}...')
    t0 = time()
    base = pd.concat([pd.read_parquet(p) for p in raw_paths], ignore_index=True)
    err(f'  {len(base):,} rows in {time() - t0:.1f}s')
    err('Sorting by dt desc (once, for topK head() correctness)...')
    t0 = time()
    base = base.sort_values('dt', ascending=False, kind='mergesort')
    err(f'  {time() - t0:.1f}s')

    h3_base_col = f'h3_r{base_res}'
    for s_res, d_res in combo_list:
        err(f'\n=== Combo s{s_res} / r{d_res} (D={d_res - s_res}) ===')
        _build_pyramid_level(base, h3_base_col, d_res, s_res, topk, pyramid_dir / f's{s_res}_r{d_res}')


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
            pyramid_combos.append({
                'shard_res': s_res,
                'data_res': d_res,
                'shard_cells': shards,
                'row_count': n_rows,
                'byte_size': n_bytes,
            })
            row_counts[f'pyramid_s{s_res}_r{d_res}'] = n_rows

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
        err(f'  combos: {len(pyramid_combos)}')
        for c in pyramid_combos:
            err(f'    s{c["shard_res"]}/r{c["data_res"]}: {len(c["shard_cells"]):,} shards, {c["row_count"]:,} rows, {c["byte_size"]/1024/1024:.1f} MB')


@cells.command('push')
@click.option('-b', '--bucket', default=R2_BUCKET_DEFAULT, help=f'R2 bucket (default: {R2_BUCKET_DEFAULT})')
@click.option('-D', '--no-delete', is_flag=True, help='Additive push (skip `--delete`). Use when local lacks legacy data still needed in R2.')
@click.option('-n', '--dry-run', is_flag=True, help='Show what would be uploaded without uploading')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-p', '--prefix', default=R2_PREFIX_DEFAULT, help=f'Bucket prefix (default: {R2_PREFIX_DEFAULT})')
@click.option('--profile', default=R2_PROFILE_DEFAULT, help=f'AWS profile for R2 (default: {R2_PROFILE_DEFAULT})')
def cells_push(bucket: str, no_delete: bool, dry_run: bool, out_dir: Path, prefix: str, profile: str):
    """Mirror `out_dir` to s3://{bucket}/{prefix}/ for the worker (excludes .dvc artifacts)."""
    s3_uri = f's3://{bucket}/{prefix}/'
    cmd = [
        'aws', 's3', 'sync', f'{out_dir}/', s3_uri,
        '--exclude', '*.dvc',
        '--exclude', '.gitignore',
    ]
    if not no_delete:
        cmd.append('--delete')
    if dry_run:
        cmd.append('--dryrun')
    env = {**os.environ, 'AWS_PROFILE': profile}
    err(f'$ AWS_PROFILE={profile} {" ".join(cmd)}')
    subprocess.run(cmd, env=env, check=True)
