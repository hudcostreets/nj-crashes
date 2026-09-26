"""Road-scoped artifacts for the map's road selection (specs/road-name-normalization-and-search.md,
Layer 4b): hover/select a *road* on the map → its crashes in a table → export.

An SRI is an official *route*, not a street: SRI `09061684__` is West Side Ave for MP 0–1.9 and
then Duncan Ave, while West Side Ave's northern continuation is other SRIs. So the unit of
selection is a **road entity**: `nj_mp_tenths` points are cut into *runs* (same SRI, same local
name — `Second_Name`, else `SLD_NAME` — contiguous MPs), and same-named runs whose ends touch
(within `ENTITY_JOIN_M`) are joined across SRIs.

All outputs are parquet under `www/public/njdot/roads/`, synced to `$NJC_S3/njdot/roads` and read
in the browser by DuckDB-WASM with ranged reads, so each is sorted for row-group pruning:

- `sri-geom.parquet`: points `(sri, mp, sld_name, name, subt, entity, alias, lon, lat)`, sorted
  `(sri, mp)`. `alias` = the most common crash-reported `road` in the point's ½-mile bin, where it
  differs from `name` (e.g. "TONNELLE AVE" along US 1): local names the SLD lacks.
- `sri-hit{-5,-6,}.parquet`: the same points sorted by S2 cell (level `HIT_S2_LEVEL`) so a viewport
  bbox prunes on row-group stats; `-5` / `-6` keep only road classes `subt` ≤ 5 / ≤ 6 (interstate
  … county), for hover at wider zooms.
- `road-entities.parquet`: one row per entity (name, route context, class, SRIs, bbox, counts,
  crash-reported aliases), sorted by `entity`.
- `road-runs.parquet`: `(entity, sri, mp_lo, mp_end)` intervals, sorted by `entity`.
- `crashes-by-entity.parquet`: crashes on an entity's runs, sorted `(entity, sri, mp, dt, id)`.
- `crashes-by-sri.parquet` / `sris.parquet`: the same by whole SRI route.
"""
import os
import subprocess
from os.path import join

import click
import duckdb
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
# Run breaks within an SRI: an MP gap or a spatial jump (discontiguous route pieces).
RUN_GAP_MP = 0.15
RUN_JUMP_M = 400
# Same-named runs whose endpoints are this close are one road entity.
ENTITY_JOIN_M = 60
# Road classes (`ROUTE_SUBT`) kept by the wider-zoom hit files.
HIT_TIERS = (5, 6)
# Crash columns shipped for the table / export (plus `lat`, `lon`).
CRASH_COLS = [
    'sri', 'mp', 'id', 'year', 'dt', 'cc', 'mc', 'case', 'severity',
    'tk', 'ti', 'pk', 'pi', 'tv', 'road', 'cross_street', 'route',
]
ROW_GROUP = {
    'crashes-by-sri': 25_000,
    'crashes-by-entity': 25_000,
    'sri-geom': 25_000,
    # Smaller groups → a click's bbox reads fewer bytes.
    'sri-hit': 8_000,
    'sris': 25_000,
    'road-entities': 25_000,
    'road-runs': 25_000,
}
M_PER_DEG_LAT = 110_540


def m_per_deg_lon(lat):
    return 111_320 * np.cos(np.radians(lat))


# Street-type / direction words → the SLD's abbreviations, so "WEST SIDE AVENUE" == "W Side Ave".
ABBREVS = {
    'AVENUE': 'AVE', 'AV': 'AVE', 'STREET': 'ST', 'ROAD': 'RD', 'BOULEVARD': 'BLVD', 'DRIVE': 'DR',
    'PLACE': 'PL', 'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TURNPIKE': 'TPKE', 'LANE': 'LN', 'COURT': 'CT',
    'TERRACE': 'TER', 'EXPRESSWAY': 'EXPY', 'ROUTE': 'RT', 'WEST': 'W', 'EAST': 'E', 'NORTH': 'N', 'SOUTH': 'S',
}
ABBREV_RE = r'\b(' + '|'.join(ABBREVS) + r')\b'


DIRECTIONS = {'W': 'WEST', 'E': 'EAST', 'N': 'NORTH', 'S': 'SOUTH'}


def name_key(s: pd.Series) -> pd.Series:
    """Looser key for joining runs into entities: `norm_name`, directions spelled out, spaces
    dropped — so "W Side Ave" == "Westside Ave" (`WESTSIDEAVE`)."""
    n = norm_name(s).str.replace(r'\b([WENS])\b', lambda m: DIRECTIONS[m.group(1)], regex=True)
    return n.str.replace(' ', '', regex=False)


def norm_name(s: pd.Series) -> pd.Series:
    """Upper-case, drop periods, collapse whitespace, abbreviate street types / directions — for
    comparing (and de-duplicating) road names."""
    s = s.astype('string').str.upper().str.replace('.', '', regex=False).str.replace(r'\s+', ' ', regex=True).str.strip()
    return s.str.replace(ABBREV_RE, lambda m: ABBREVS[m.group(1)], regex=True)


def crashes_by_sri(crashes: pd.DataFrame, latlon: pd.DataFrame) -> pd.DataFrame:
    """Crashes with a non-empty SRI, joined to their effective `lat`/`lon` (left join on the index,
    so ungeocoded crashes are kept), sorted `(sri, mp, dt, id)`."""
    df = crashes[crashes['sri'].notna() & (crashes['sri'] != '')]
    df = df[CRASH_COLS].join(latlon[['lat', 'lon']], how='left')
    # Per-table years and AASHTO disagree on some types (e.g. `route` is int in one, str in the
    # other), so object columns are mixed after the concat; normalize them to `string` for arrow.
    for col in df.select_dtypes('object').columns:
        df[col] = df[col].astype('string')
    df['id'] = df['id'].astype('Int64')  # AASHTO rows have no `id` → NaN after the concat
    return df.sort_values(['sri', 'mp', 'dt', 'id'], kind='stable', na_position='last').reset_index(drop=True)


def sri_geom(mp: pd.DataFrame) -> pd.DataFrame:
    """`nj_mp_tenths` → `(sri, mp, sld_name, name, subt, lon, lat)` (geocoded points only), sorted
    `(sri, mp)`. `name` is the local street name (`Second_Name`), else the SLD route name. A lone
    point whose name differs from both SRI neighbors is a label artifact (e.g. a cross street's MP
    0.0 point named for the road it starts on) and takes its neighbor's name."""
    df = mp.rename(columns={'SRI': 'sri', 'MP': 'mp', 'SLD_NAME': 'sld_name', 'ROUTE_SUBT': 'subt'})
    second = df['Second_Name'].astype('string').str.strip()
    df['name'] = second.where(second.notna() & (second != ''), df['sld_name'].astype('string'))
    df['subt'] = df['subt'].astype('int8')
    df = df[['sri', 'mp', 'sld_name', 'name', 'subt', 'lon', 'lat']]
    df = df[df['lat'].notna() & df['lon'].notna()]  # a few hundred ungeocoded tenths: undrawable
    df = df.sort_values(['sri', 'mp'], kind='stable').reset_index(drop=True)
    sri, name = df['sri'], df['name']
    p1 = name.shift(1).where(sri.eq(sri.shift(1)))
    p2 = name.shift(2).where(sri.eq(sri.shift(2)))
    n1 = name.shift(-1).where(sri.eq(sri.shift(-1)))
    n2 = name.shift(-2).where(sri.eq(sri.shift(-2)))
    # Interior: both neighbors agree on another name. Ends: the next (previous) two agree.
    interior = p1.notna() & n1.notna() & p1.eq(n1).fillna(False) & name.ne(p1).fillna(False)
    first = p1.isna() & n2.notna() & n1.eq(n2).fillna(False) & name.ne(n1).fillna(False)
    last = n1.isna() & p2.notna() & p1.eq(p2).fillna(False) & name.ne(p1).fillna(False)
    df.loc[interior | last, 'name'] = p1[interior | last]
    df.loc[first, 'name'] = n1[first]
    return df


def road_runs(geom: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """Cut `geom` (sorted `(sri, mp)`) into runs: same SRI + local name, contiguous MPs. Returns one
    row per run: `run, sri, name, sld_name, subt, mp_lo, mp_hi, mp_end, lon0, lat0, lon1, lat1`,
    where `[mp_lo, mp_end)` is the run's crash-assignment interval (up to the next run's `mp_lo` on
    the same SRI, else a tenth past `mp_hi`), and `(lon0, lat0)` / `(lon1, lat1)` its end points.
    Also returns each `geom` row's run index."""
    g = geom
    prev_sri, prev_name, prev_mp = g['sri'].shift(), g['name'].shift(), g['mp'].shift()
    dx = (g['lon'] - g['lon'].shift()) * m_per_deg_lon(g['lat'])
    dy = (g['lat'] - g['lat'].shift()) * M_PER_DEG_LAT
    brk = (
        (g['sri'] != prev_sri) | (g['name'] != prev_name).fillna(True)
        | (g['mp'] - prev_mp > RUN_GAP_MP) | (np.hypot(dx, dy) > RUN_JUMP_M)
    )
    run = (brk.cumsum() - 1).to_numpy()
    agg = g.assign(run=run).groupby('run').agg(
        sri=('sri', 'first'), name=('name', 'first'), sld_name=('sld_name', 'first'), subt=('subt', 'min'),
        mp_lo=('mp', 'first'), mp_hi=('mp', 'last'),
        lon0=('lon', 'first'), lat0=('lat', 'first'), lon1=('lon', 'last'), lat1=('lat', 'last'),
    ).reset_index()
    nxt = agg['mp_lo'].shift(-1).where(agg['sri'].shift(-1) == agg['sri'])
    agg['mp_end'] = nxt.fillna(agg['mp_hi'] + 0.1)
    return agg, run


def road_entities(runs: pd.DataFrame) -> pd.Series:
    """Entity id per run: same-(normalized-)named runs whose end points are within `ENTITY_JOIN_M`
    are one road (union-find over a ~`ENTITY_JOIN_M` grid of end points). Ids are numbered in
    `(sri, mp_lo)` order of each entity's first run, so they're deterministic."""
    parent = np.arange(len(runs))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    names = name_key(runs['name']).to_numpy()
    ends = []
    for lon_c, lat_c in (('lon0', 'lat0'), ('lon1', 'lat1')):
        ends.append(pd.DataFrame({'run': runs.index, 'lon': runs[lon_c].to_numpy(), 'lat': runs[lat_c].to_numpy()}))
    ends = pd.concat(ends, ignore_index=True)
    cell = ENTITY_JOIN_M / M_PER_DEG_LAT
    ends['gy'] = np.floor(ends['lat'] / cell).astype(np.int64)
    ends['gx'] = np.floor(ends['lon'] * m_per_deg_lon(ends['lat']) / ENTITY_JOIN_M).astype(np.int64)
    buckets: dict = {}
    for r, gx, gy in zip(ends['run'].to_numpy(), ends['gx'].to_numpy(), ends['gy'].to_numpy()):
        buckets.setdefault((names[r], gx, gy), []).append(r)
    lon = ends['lon'].to_numpy(); lat = ends['lat'].to_numpy(); erun = ends['run'].to_numpy()
    for k, (r, gx, gy) in enumerate(zip(erun, ends['gx'].to_numpy(), ends['gy'].to_numpy())):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for r2 in buckets.get((names[r], gx + dx, gy + dy), ()):
                    if r2 == r:
                        continue
                    # Compare against both ends of `r2`.
                    for lon2, lat2 in ((runs.at[r2, 'lon0'], runs.at[r2, 'lat0']), (runs.at[r2, 'lon1'], runs.at[r2, 'lat1'])):
                        d = np.hypot((lon2 - lon[k]) * m_per_deg_lon(lat[k]), (lat2 - lat[k]) * M_PER_DEG_LAT)
                        if d <= ENTITY_JOIN_M:
                            a, b = find(r), find(r2)
                            if a != b:
                                parent[max(a, b)] = min(a, b)
    roots = np.array([find(i) for i in range(len(runs))])
    first = pd.DataFrame({'root': roots, 'sri': runs['sri'].to_numpy(), 'mp_lo': runs['mp_lo'].to_numpy()})
    order = first.sort_values(['sri', 'mp_lo'], kind='stable').drop_duplicates('root')['root']
    ids = {root: i for i, root in enumerate(order)}
    return pd.Series([ids[r] for r in roots], index=runs.index, name='entity', dtype='int32')


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


def assign_crashes(by_sri: pd.DataFrame, runs: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """Crashes on an entity's runs (`sri` match, `mp` in `[mp_lo, mp_end)`), with `entity` + `run`, sorted
    `(entity, sri, mp, dt, id)`. Crashes whose MP falls outside every run (bad MPs, SRIs missing
    from `nj_mp_tenths`) aren't on any entity; they stay in `crashes-by-sri`."""
    con.register('c', by_sri)
    con.register('r', runs[['entity', 'run', 'sri', 'mp_lo', 'mp_end']])
    out = con.sql("""
        SELECT r.entity, r.run, c.* FROM c JOIN r ON c.sri = r.sri AND c.mp >= r.mp_lo AND c.mp < r.mp_end
        ORDER BY r.entity, c.sri, c.mp, c.dt, c.id
    """).df()
    con.unregister('c'); con.unregister('r')
    return out


def top_aliases(crashes: pd.DataFrame, keys: list[str], k: int, min_n: int) -> pd.DataFrame:
    """Top-`k` normalized crash-reported `road` names per `keys` group (seen ≥ `min_n` times), as
    `keys + [alias, n]` rows, most common first (ties by name)."""
    c = crashes[keys + ['road']].dropna(subset=['road'])
    c = c.assign(alias=norm_name(c['road'])).dropna(subset=['alias'])
    c = c[c['alias'] != '']
    n = c.groupby(keys + ['alias']).size().rename('n').reset_index()
    n = n[n['n'] >= min_n].sort_values(keys + ['n', 'alias'], ascending=[True] * len(keys) + [False, True])
    return n.groupby(keys, sort=False).head(k).reset_index(drop=True)


def point_aliases(geom: pd.DataFrame, point_run: np.ndarray, by_entity: pd.DataFrame, min_n: int = 3) -> pd.Series:
    """Per `geom` point: the most common crash-reported `road` (normalized) among its run's crashes
    in the same ½-mile MP bin, if seen ≥ `min_n` times and not just the point's own `name`."""
    c = by_entity[['run', 'mp', 'road']].assign(bin=np.floor(by_entity['mp'] * 2) / 2)
    top = top_aliases(c, ['run', 'bin'], k=1, min_n=min_n)
    pts = pd.DataFrame({'run': point_run, 'bin': np.floor(geom['mp'].to_numpy() * 2) / 2, 'name': norm_name(geom['name']).to_numpy()})
    merged = pts.merge(top[['run', 'bin', 'alias']], on=['run', 'bin'], how='left')
    alias = merged['alias'].astype('string')
    return alias.where(alias != merged['name']).set_axis(geom.index)


def entity_table(runs: pd.DataFrame, geom: pd.DataFrame, by_entity: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """One row per entity: `name`, `route` (the SLD route name, where it differs — e.g. "US 1" for
    Tonnelle Ave), min road class `subt`, `sris` (comma-joined), bbox, crash counts, and `aliases`
    (the top 3 crash-reported `road` names that differ from `name`, " · "-joined)."""
    con.register('r', runs.assign(n=runs['mp_hi'] - runs['mp_lo'] + 0.1))
    con.register('g', geom[['entity', 'lon', 'lat']])
    con.register('c', by_entity[['entity', 'severity', 'tk']])
    out = con.sql("""
        WITH names AS (
            SELECT entity, arg_max(name, n) AS name, arg_max(sld_name, n) AS sld_name, min(subt) AS subt,
                   string_agg(DISTINCT sri, ',' ORDER BY sri) AS sris
            FROM r GROUP BY entity
        ), bbox AS (
            SELECT entity, min(lon) lon_min, min(lat) lat_min, max(lon) lon_max, max(lat) lat_max FROM g GROUP BY entity
        ), counts AS (
            SELECT entity, count(*)::INT n_crashes, count_if(severity = 'f')::INT n_fatal,
                   count_if(severity = 'i')::INT n_injury, coalesce(sum(tk), 0)::INT n_killed
            FROM c GROUP BY entity
        )
        SELECT n.entity, n.name, n.sld_name, n.subt, n.sris, b.lon_min, b.lat_min, b.lon_max, b.lat_max,
               coalesce(k.n_crashes, 0)::INT n_crashes, coalesce(k.n_fatal, 0)::INT n_fatal,
               coalesce(k.n_injury, 0)::INT n_injury, coalesce(k.n_killed, 0)::INT n_killed
        FROM names n JOIN bbox b USING (entity) LEFT JOIN counts k USING (entity)
        ORDER BY n.entity
    """).df()
    for t in ('r', 'g', 'c'):
        con.unregister(t)
    name_n = norm_name(out['name'])
    out['route'] = out['sld_name'].astype('string').where(norm_name(out['sld_name']) != name_n)
    al = top_aliases(by_entity[['entity', 'road']], ['entity'], k=4, min_n=1)
    al = al.merge(pd.DataFrame({'entity': out['entity'], 'name_n': name_n}), on='entity')
    al = al[al['alias'] != al['name_n']].groupby('entity', sort=False).head(3)
    aliases = al.groupby('entity')['alias'].agg(' · '.join)
    out['aliases'] = out['entity'].map(aliases).astype('string')
    cols = ['entity', 'name', 'route', 'subt', 'sris', 'lon_min', 'lat_min', 'lon_max', 'lat_max',
            'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases']
    return out[cols]


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
    err('Runs + entities...')
    runs, point_run = road_runs(geom)
    runs['entity'] = road_entities(runs)
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    con = duckdb.connect()
    con.sql("SET memory_limit='12GB'; SET threads=4")
    by_entity = assign_crashes(by_sri, runs, con)
    geom['alias'] = point_aliases(geom, point_run, by_entity)
    ents = entity_table(runs, geom, by_entity, con)
    err(f'  {len(runs):,} runs → {len(ents):,} entities; {len(by_entity):,} of {len(by_sri):,} SRI crashes on an entity')
    err('Writing...')
    write(by_sri, join(out_dir, 'crashes-by-sri.parquet'), ROW_GROUP['crashes-by-sri'])
    write(by_entity.drop(columns=['run']), join(out_dir, 'crashes-by-entity.parquet'), ROW_GROUP['crashes-by-entity'])
    write(geom, join(out_dir, 'sri-geom.parquet'), ROW_GROUP['sri-geom'])
    hit = sri_hit(geom)
    write(hit, join(out_dir, 'sri-hit.parquet'), ROW_GROUP['sri-hit'])
    for tier in HIT_TIERS:
        write(hit[hit['subt'] <= tier].reset_index(drop=True), join(out_dir, f'sri-hit-{tier}.parquet'), ROW_GROUP['sri-hit'])
    write(sris(geom, by_sri), join(out_dir, 'sris.parquet'), ROW_GROUP['sris'])
    write(ents, join(out_dir, 'road-entities.parquet'), ROW_GROUP['road-entities'])
    write(runs[['entity', 'sri', 'mp_lo', 'mp_end']].sort_values(['entity', 'sri', 'mp_lo']).reset_index(drop=True),
          join(out_dir, 'road-runs.parquet'), ROW_GROUP['road-runs'])


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
