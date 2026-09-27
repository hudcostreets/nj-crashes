"""Road-scoped artifacts for the map's road selection (specs/road-data-v3.md; Layer 4b of
specs/road-name-normalization-and-search.md): hover/select a *road* on the map → its crashes in a
table → export; search roads by name (⌘K).

An SRI is an official *route*, not a street: SRI `09061684__` is West Side Ave for MP 0–1.9 and
then Duncan Ave, while West Side Ave's northern continuation is other SRIs. So the unit of
selection is a **road entity**. Sources (`njdot roads fetch-network` / `fetch-ng911`):

- NJDOT Roadway Network lines (M-aware) → MP points every 0.05 mi (`njdot.road_net.rn_points`).
- NJOGIS NG9-1-1 centerlines, projected onto those lines, name each point (`name_points`); points
  are cut into *runs* (same SRI, name, county; contiguous MPs), and runs that touch and share a
  name or NG911 local alias within a county are one entity (`njdot.road_net.road_entities`).

All outputs are parquet under `www/public/njdot/roads/`, synced to `$NJC_S3/njdot/roads` and read
in the browser by DuckDB-WASM with ranged reads, so each is sorted for row-group pruning
(specs/road-data-v4.md has schemas, row-group sizes and bytes per lookup). Entity ids are ranks in
`slug` order (`njdot.road_outputs`), so every entity-sorted file is also slug-sorted:

- `sri-geom.parquet`: points `(sri, mp, sld_name, name, subt, entity, alias, lon, lat)`, sorted
  `(entity, sri, mp)` (stats on `entity` only: look points up by road, not SRI; `sris.parquet`
  has per-SRI extents). `name` = the NG911 local street name (else the NJDOT `SLD_NAME`); `alias` = the
  dominant crash-reported `road` in the point's ½-mile stretch, where it differs from `name`.
- `sri-hit{-5,-6,}.parquet`: the same points sorted by S2 cell (level `HIT_S2_LEVEL`) so a viewport
  bbox prunes on row-group stats; `-5` / `-6` keep only road classes `subt` ≤ 5 / ≤ 6 (interstate
  … county), for hover at wider zooms.
- `road-entities.parquet`: one row per entity (`slug`, local name, route designation, class, SRIs,
  bbox, counts, aliases, county, muni, munis, `length_mi`), sorted by `entity` (= by `slug`).
- `road-runs.parquet`: `(entity, sri, mp_lo, mp_end)` intervals, sorted by `entity`.
- `road-summary{,-monthly}.parquet`: crash counts per `(entity, year[, month], severity)`.
- `road-ranks.parquet`: each county's / muni's top roads by crashes, fatal crashes, killed, crashes
  per mile, sorted `(cc, mc)`.
- `road-search.parquet`: the ⌘K word index, one row per `(token, searchable name)`, sorted by `token`.
- `crashes-by-entity.parquet`: crashes on an entity's runs, sorted `(entity, sri, mp, dt, id)`.
- `crashes-by-sri.parquet` / `sris.parquet`: the same by whole SRI route (`crashes-by-sri` also
  carries each crash's `entity`, null when on none).
- `road-notes.parquet`: data notes per road / corridor (`njdot.road_notes`; specs/road-anomalies.md).
"""
import json
import os
import subprocess
import time
from os.path import dirname, exists, join

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from click import option

from nj_crashes.utils.log import err
from njdot.load import load_crashes_with_aashto
from njdot.loc_recovery import PRIVATE_ROAD_SYSTEM, ng_name_index, recover_unassigned, recovery_context
from njdot.map_base import _build_base
from njdot.paths import NG911_DIR, ROADS_DIR, ROADS_S3, ROADWAY_NETWORK
from njdot.road_audit import audit
from njdot.road_net import (
    M_PER_DEG_LAT, m_per_deg_lon, merge_key, name_points, ng_intervals, ng_segments, norm_name, rn_features, rn_points, road_entities,
    run_names, seg_aliases,
)
from njdot.cc2mc2mn import CC2MC2MN, cc2mc2mn
from njdot.road_model import Steps, block_of, block_pos, block_stats, model_outputs, node_table, xs_rows
from njdot.road_notes import ROAD_NOTES, Note, gap_notes, load_notes, muni_gaps, road_notes
from njdot.road_overrides import ROAD_OVERRIDES, Override, apply_overrides, apply_recodes, load_overrides
from njdot.road_outputs import (
    UNPLACED_SOURCES, entity_lengths, entity_slugs, point_mc, road_ranks, road_search_index, road_summary, search_meta,
    slug_order, unplaced,
)
from njdot.road_sources import HUDSON_GNIS, fetch_network, fetch_ng911, read_meta, write_parquet
from njdot.s2 import latlng_to_id

from .base import njdot
from .cells import MAP_INPUT_COLS

HIT_S2_LEVEL = 16
# Run breaks within an SRI: an MP gap or a spatial jump (discontiguous route pieces).
RUN_GAP_MP = 0.15
RUN_JUMP_M = 400
# Name blips (`smooth_names`): up to this many points renamed to match both neighbors.
MAX_BLIP_PTS = 3
# A run's crash interval extends at most this far past its last point.
RUN_TAIL_MP = 0.1
# Road classes (`ROUTE_SUBT`) kept by the wider-zoom hit files.
HIT_TIERS = (5, 6)
# Crash columns shipped for the table / export (plus `lat`, `lon`).
CRASH_COLS = [
    'sri', 'mp', 'id', 'year', 'dt', 'cc', 'mc', 'case', 'severity',
    'tk', 'ti', 'pk', 'pi', 'tv', 'road', 'cross_street', 'route',
]
ALIAS_MIN_N = 3
ALIAS_MIN_FRAC = 0.02
# A crash-reported name is a stretch's alias only if it's this share of the stretch's candidate strings.
ALIAS_DOMINANT_FRAC = 0.5
# Per entity: at most this many NG911 local aliases / crash-reported aliases / route designations.
NG_ALIASES_MAX = 5
CRASH_ALIASES_MAX = 3
# An NG911 local alias is listed on the entity (`aliases`) if it covers ≥ this share of its NG911-named points.
ENTITY_ALIAS_FRAC = 0.1
ROUTES_MAX = 3
ROW_GROUP = {
    'crashes-by-sri': 25_000,
    # 10k rows ≈ 210 KB per group, footer ≈ 565 KB (5k: 105 KB / 1.1 MB; see specs/road-data-v4.md).
    'crashes-by-entity': 10_000,
    # Sorted by entity: a road's points (≤ ~1.5k) are 1–2 groups of ~86 KB; footer ≈ 160 KB
    # (group / footer at 2k rows: 40 KB / 320 KB; 8k: 170 KB / 80 KB; see specs/road-data-v4.md).
    'sri-geom': 4_000,
    # Smaller groups → a click's bbox reads fewer bytes.
    'sri-hit': 8_000,
    'sris': 25_000,
    'road-entities': 1_000,
    # A road's runs: one ~18 KB group; footer ≈ 20 KB.
    'road-runs': 2_000,
    'road-summary': 10_000,
    'road-summary-monthly': 20_000,
    'road-ranks': 2_000,
    'road-search': 2_000,
    # v5 (specs/road-model-v5.md).
    'crashes-by-entity-xs': 10_000,
    'road-pieces': 2_000,
    'road-blocks': 4_000,
    'road-nodes': 4_000,
    'road-node-entities': 4_000,
    'road-corridors': 1_000,
    'road-corridor-summary': 10_000,
    'road-corridor-summary-monthly': 20_000,
    # specs/road-anomalies.md § Data notes: a few hundred rows.
    'road-notes': 10_000,
}
# Dictionary-encode only these columns (a small row group's dictionary of mostly-distinct strings
# costs more than it saves); default all.
DICT = {
    'crashes-by-entity': ['sri', 'severity', 'road', 'cross_street', 'route', 'loc_source', 'override'],
    'crashes-by-entity-xs': ['sri', 'severity', 'road', 'cross_street', 'route', 'loc_source', 'override'],
    'road-pieces': ['sri', 'join'],
    'road-blocks': ['from_name', 'to_name'],
    'road-nodes': [],
    'road-node-entities': ['cross'],
    'road-corridors': ['kind'],
    'road-notes': ['note', 'kind', 'title', 'text'],
    'road-entities': [],
    'road-ranks': [],
    'road-search': ['token', 'kind', 'place', 'words'],
}
# Files with many small row groups: min/max stats only on the columns lookups filter on.
STATS = {
    'crashes-by-entity': ['entity', 'chain'],
    'crashes-by-entity-xs': ['entity', 'chain'],
    'road-pieces': ['entity'],
    'road-blocks': ['entity', 'chain_lo', 'chain_hi'],
    'road-nodes': ['node', 'lon', 'lat'],
    'road-node-entities': ['entity', 'chain'],
    'road-corridors': ['corridor', 'slug'],
    'road-corridor-summary': ['corridor'],
    'road-corridor-summary-monthly': ['corridor'],
    'road-notes': ['entity', 'corridor'],
    'road-entities': ['entity', 'slug', 'cc', 'mc'],
    'sri-geom': ['entity'],
    'road-runs': ['entity'],
    'road-summary': ['entity'],
    'road-summary-monthly': ['entity'],
    'road-ranks': ['cc', 'mc'],
    'road-search': ['token'],
}
# Outputs of earlier versions, removed from `out_dir` (so `roads sync --delete` drops them from S3).
STALE = ['road-names.parquet']
ENTITY_COLS = [
    'entity', 'slug', 'name', 'route', 'subt', 'sris', 'lon_min', 'lat_min', 'lon_max', 'lat_max',
    'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases', 'cc', 'mc', 'munis', 'length_mi',
]
# v5 (specs/road-model-v5.md), after the v4 columns.
ENTITY_V5_COLS = [
    'corridor', 'corridor_c0', 'corridor_sign', 'chain_mi', 'n_nodes',
    'n_crashes_xs', 'n_fatal_xs', 'n_injury_xs', 'n_killed_xs',
]

def crash_rows(crashes: pd.DataFrame, latlon: pd.DataFrame, extra: list[str] | None = None) -> pd.DataFrame:
    """`CRASH_COLS` (+ `extra`, where present) of `crashes`, joined to their effective `lat`/`lon`
    (left join on the index, so ungeocoded crashes are kept)."""
    cols = CRASH_COLS + [c for c in (extra or []) if c in crashes]
    df = crashes[cols].join(latlon[['lat', 'lon']], how='left')
    # Per-table years and AASHTO disagree on some types (e.g. `route` is int in one, str in the
    # other), so object columns are mixed after the concat; normalize them to `string` for arrow.
    for col in df.select_dtypes('object').columns:
        df[col] = df[col].astype('string')
    df['id'] = df['id'].astype('Int64')  # AASHTO rows have no `id` → NaN after the concat
    return df


def crashes_by_sri(crashes: pd.DataFrame, latlon: pd.DataFrame, extra: list[str] | None = None) -> pd.DataFrame:
    """Crashes with a non-empty SRI (`crash_rows`), sorted `(sri, mp, dt, id)`."""
    df = crash_rows(crashes[crashes['sri'].notna() & (crashes['sri'] != '')], latlon, extra)
    return df.sort_values(['sri', 'mp', 'dt', 'id'], kind='stable', na_position='last').reset_index(drop=True)


# Crash columns `recover` needs beyond `MAP_INPUT_COLS` (offset from the cross street; road class).
RECOVERY_COLS = ['road_system', 'cross_street_distance', 'Unit Of Measurement', 'Direction From Cross Street']
# … and the intersection association (`road_model.crash_nodes`): NJDOT's intersection flag.
XS_COLS = ['Intersection']
# The police location fields carried through `by_sri` / `by_entity` for `crash_nodes`, and the id of
# the `recode` override that rewrote a crash's location fields (`apply_recodes`; → `override`). Not written.
LOC_COLS = ['cross_street_distance', 'Unit Of Measurement', 'Intersection', '_recode']
# AASHTO (2024+) names its `road_system`s; only private property matters to recovery.
AASHTO_ROAD_SYSTEMS = {'Private Property': PRIVATE_ROAD_SYSTEM}


def road_system_codes(s: pd.Series) -> pd.Series:
    """`road_system` after the per-table (int codes) ∪ AASHTO (names) concat → int codes (`Int8`);
    AASHTO names via `AASHTO_ROAD_SYSTEMS`, others NA."""
    num = pd.to_numeric(s, errors='coerce')
    named = s.map(AASHTO_ROAD_SYSTEMS)
    return num.fillna(pd.to_numeric(named, errors='coerce')).astype('Int8')


def load_build_crashes(cc: int | None = None) -> pd.DataFrame:
    """`load_crashes_with_aashto` with `id` and the columns `roads build` needs (`MAP_INPUT_COLS`,
    `RECOVERY_COLS`), `prep_crashes`'d; `cc`: only that county's (dev subsets)."""
    crashes = load_crashes_with_aashto(columns=MAP_INPUT_COLS + ['id'] + RECOVERY_COLS + XS_COLS)
    if cc is not None:
        crashes = crashes[crashes['cc'] == cc].reset_index(drop=True)
    return prep_crashes(crashes)


def prep_crashes(crashes: pd.DataFrame) -> pd.DataFrame:
    """Normalize `RECOVERY_COLS` / `XS_COLS` types across the per-table ∪ AASHTO concat (in place)."""
    crashes['road_system'] = road_system_codes(crashes['road_system'])
    for c in ('Unit Of Measurement', 'Direction From Cross Street', 'Intersection'):
        if c in crashes:
            crashes[c] = crashes[c].astype('string')
    crashes['cross_street_distance'] = pd.to_numeric(crashes['cross_street_distance'], errors='coerce')
    return crashes


# `loc_source`s with a map point (coded or recovered SRI + MP) vs. assigned to an entity only.
PLACED_SOURCES = ('sri_mp', 'intersection', 'route_xs', 'latlon_snap', 'sri_calib')


def fold_recovery(crashes: pd.DataFrame, latlon: pd.DataFrame, rec: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Fold `recover_unassigned` output `rec` (a subset of `crashes`' index) into `crashes`: adds
    `loc_source` (default "sri_mp": crashes `rec` doesn't cover are on an entity by their coded
    SRI / MP), `how` and `_ent` (the entity of `sri_only` / `name_only` crashes), and takes `rec`'s
    `sri` / `mp` wherever it recovered a location. Returns it and `latlon` (every crash's effective
    `lat` / `lon`): the recovered point for `intersection` / `route_xs` / `sri_calib`, the reported one (as
    before) for `latlon_snap`, none for `sri_only` / `name_only` (no map point)."""
    c = crashes.copy()
    ll = latlon[['lat', 'lon']].reindex(c.index)
    src = pd.Series('sri_mp', index=c.index, dtype='string')
    src.loc[rec.index] = rec['loc_source'].astype('string')
    c['loc_source'] = src
    c['how'] = pd.Series(pd.NA, index=c.index, dtype='string')
    tried = rec[rec['loc_source'] != 'sri_mp']
    c.loc[tried.index, 'how'] = tried['how']
    c['_ent'] = pd.Series(pd.NA, index=c.index, dtype='Int32')
    recovered = rec[~rec['loc_source'].isin(['sri_mp', 'none'])]
    unpl = recovered[recovered['loc_source'].isin(UNPLACED_SOURCES)]
    c.loc[unpl.index, '_ent'] = unpl['entity']
    # A road name that's several entities' (`cands`): placed on their corridor later, if one.
    cands = rec['cands'].where(rec['loc_source'].eq('none')) if 'cands' in rec else pd.Series(None, index=rec.index, dtype=object)
    c['_cands'] = cands.reindex(c.index).astype(object).where(lambda x: x.notna(), None)
    c['sri'] = c['sri'].astype('string')
    c.loc[recovered.index, 'sri'] = recovered['sri']
    c['mp'] = c['mp'].astype('float32')
    c.loc[recovered.index, 'mp'] = recovered['mp'].astype('float32')
    pt = recovered[recovered['loc_source'].isin(['intersection', 'route_xs', 'sri_calib'])]
    ll.loc[pt.index, 'lat'] = pt['lat'].astype('float32')
    ll.loc[pt.index, 'lon'] = pt['lon'].astype('float32')
    ll.loc[unpl.index] = np.nan
    return c, ll.dropna()


def entity_crashes(by_sri: pd.DataFrame, crashes: pd.DataFrame, latlon: pd.DataFrame, runs: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """All crashes assigned to an entity (`road_outputs`' `by_entity` input): `by_sri` (with `_i`,
    and `loc_source` / `_ent` when recovery ran) crashes on a run (`assign_crashes`), then its
    `sri_only` crashes (`_ent`), then `crashes`' `name_only` ones (no SRI: not in `by_sri`; no
    `_i`). The unplaced ones have no `run`, `mp`, `lat` / `lon`."""
    cols = [c for c in by_sri.columns if c != '_ent']
    placed = assign_crashes(by_sri[cols], runs, con)
    if '_ent' not in by_sri:
        return placed
    sri_only = by_sri[by_sri['loc_source'].eq('sri_only').fillna(False).to_numpy()]
    name_only = crash_rows(crashes[crashes['loc_source'].eq('name_only').fillna(False).to_numpy()], latlon, ['loc_source', 'how', '_ent'] + LOC_COLS)
    unpl = pd.concat([sri_only, name_only], ignore_index=True)
    unpl = unpl.assign(entity=unpl["_ent"], run=pd.NA)[["entity", "run"] + cols]
    out = pd.concat([placed.astype({'entity': 'Int32', 'run': 'Int64'}), unpl.astype({"entity": "Int32", "run": "Int64"})], ignore_index=True)
    for col in out.select_dtypes('object').columns:
        out[col] = out[col].astype('string')
    return out.astype({'id': 'Int64', '_i': 'Int64'})


# `crashes_by_sri`'s nullable dtypes, which a written `crashes-by-sri.parquet` doesn't record (`write`
# stores no pandas metadata): read back plainly, they're float64 / object.
BY_SRI_DTYPES = {'id': 'Int64', 'cc': 'Int8', 'mc': 'Float64', 'entity': 'Int32'}


def read_crashes_by_sri(path: str) -> pd.DataFrame:
    """A `crashes-by-sri.parquet` with `crashes_by_sri`'s dtypes (strings as `string`)."""
    df = pd.read_parquet(path)
    for col in df.select_dtypes('object').columns:
        df[col] = df[col].astype('string')
    return df.astype({c: t for c, t in BY_SRI_DTYPES.items() if c in df})


def smooth_names(df: pd.DataFrame, max_blip: int = MAX_BLIP_PTS) -> pd.DataFrame:
    """Absorb naming blips in `df` (points sorted `(sri, mp)`): a block of ≤ `max_blip` consecutive
    points whose `(name, cc)` differs from the matching blocks on both sides (same SRI) takes
    theirs — e.g. 2 points NG911 calls "Kennedy Boulevard" inside "J F Kennedy Boulevard", or a
    point of a county-line road on the other county's side. A single point at an SRI end takes its
    neighbor's if the next two points agree (a cross street's MP 0.0 point named for the road it
    starts on). Smallest blips go first, repeatedly, so alternating blips resolve to the
    surrounding name. `seg` / `muni` keep the points' own NG911 facts."""
    df = df.copy()
    has_cc = 'cc' in df
    for _ in range(4 * max_blip):
        key = df['name'].astype('string').fillna('')
        if has_cc:
            key = key + '|' + df['cc'].astype('string').fillna('')
        sri = df['sri']
        blk = ((sri != sri.shift()) | (key != key.shift())).cumsum()
        b = pd.DataFrame({'sri': sri, 'key': key, 'blk': blk}).groupby('blk', sort=True).agg(sri=('sri', 'first'), key=('key', 'first'), n=('key', 'size'))
        ps, pk, pc = b['sri'].shift(), b['key'].shift(), b['n'].shift()
        ns, nk, nc = b['sri'].shift(-1), b['key'].shift(-1), b['n'].shift(-1)
        interior = (ps == b['sri']) & (ns == b['sri']) & (b['n'] <= max_blip) & (pk == nk) & (b['key'] != pk)
        first = (ps != b['sri']) & (ns == b['sri']) & (b['n'] == 1) & (nc >= 2) & (b['key'] != nk)
        last = (ns != b['sri']) & (ps == b['sri']) & (b['n'] == 1) & (pc >= 2) & (b['key'] != pk)
        cand = interior | first | last
        if not cand.any():
            break
        k = b['n'][cand].min()
        take_prev = ((interior | last) & (b['n'] == k)).to_numpy()
        take_next = (first & (b['n'] == k)).to_numpy()
        # Each point's source row: the last point of the previous block, or the first of the next.
        bi = blk.to_numpy() - 1
        starts = np.r_[0, np.flatnonzero(np.diff(bi)) + 1]
        ends = np.r_[starts[1:] - 1, len(df) - 1]
        src = np.full(len(df), -1)
        prev_m, next_m = take_prev[bi], take_next[bi]
        src[prev_m] = ends[bi[prev_m] - 1]
        src[next_m] = starts[bi[next_m] + 1]
        m = src >= 0
        cols = ['name', 'cc'] if has_cc else ['name']
        for c in cols:
            vals = df[c].to_numpy(copy=True)
            vals[m] = df[c].to_numpy()[src[m]]
            df[c] = pd.array(vals, dtype=df[c].dtype)
    return df


def road_runs(geom: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """Cut `geom` (sorted `(sri, mp)`) into runs: same SRI + local name + county (`cc`, when
    present), contiguous MPs. Returns one row per run: `run, sri, name, sld_name, subt, cc, mp_lo,
    mp_hi, mp_end, lon0, lat0, lon1, lat1` (+ `muni`, its first NG911 muni, when `geom` has one),
    where `[mp_lo, mp_end)` is the run's crash-assignment interval (up to the next run's `mp_lo` on
    the same SRI, but at most `RUN_TAIL_MP` past `mp_hi`), and `(lon0, lat0)` / `(lon1, lat1)` its end points.
    Also returns each `geom` row's run index."""
    g = geom
    prev_sri, prev_name, prev_mp = g['sri'].shift(), g['name'].shift(), g['mp'].shift()
    dx = (g['lon'] - g['lon'].shift()) * m_per_deg_lon(g['lat'])
    dy = (g['lat'] - g['lat'].shift()) * M_PER_DEG_LAT
    cc = g['cc'].astype('Int64').fillna(-1) if 'cc' in g else pd.Series(-1, index=g.index)
    brk = (
        (g['sri'] != prev_sri) | (g['name'] != prev_name).fillna(True) | (cc != cc.shift())
        | (g['mp'] - prev_mp > RUN_GAP_MP) | (np.hypot(dx, dy) > RUN_JUMP_M)
    )
    run = (brk.cumsum() - 1).to_numpy()
    extra = {'muni': ('muni', 'first')} if 'muni' in g else {}
    agg = g.assign(run=run, cc=cc.where(cc >= 0).astype('Int8')).groupby('run').agg(
        sri=('sri', 'first'), name=('name', 'first'), sld_name=('sld_name', 'first'), subt=('subt', 'min'), cc=('cc', 'first'), **extra,
        mp_lo=('mp', 'first'), mp_hi=('mp', 'last'),
        lon0=('lon', 'first'), lat0=('lat', 'first'), lon1=('lon', 'last'), lat1=('lat', 'last'),
    ).reset_index()
    # A run's crashes: up to the next run on the SRI, but not across an MP gap (crash MPs inside a
    # gap — e.g. where the route is co-signed on another SRI — have no line to sit on).
    nxt = agg['mp_lo'].shift(-1).where(agg['sri'].shift(-1) == agg['sri'])
    agg['mp_end'] = np.round(np.fmin(nxt.fillna(np.inf), agg['mp_hi'] + RUN_TAIL_MP), 6)
    return agg, run


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
    from the Roadway Network) aren't on any entity; they stay in `crashes-by-sri`."""
    con.register('c', by_sri)
    con.register('r', runs[['entity', 'run', 'sri', 'mp_lo', 'mp_end']])
    # `_i` (the row in `by_sri`) breaks ties (AASHTO rows have no `id`): DuckDB's sort isn't stable.
    tie = ', c._i' if '_i' in by_sri else ''
    out = con.sql(f"""
        SELECT r.entity, r.run, c.* FROM c JOIN r ON c.sri = r.sri AND c.mp >= r.mp_lo AND c.mp < r.mp_end
        ORDER BY r.entity, c.sri, c.mp, c.dt, c.id{tie}
    """).df()
    con.unregister('c'); con.unregister('r')
    return out


# A bare route designation ("US 1", "RT 1", "NJ 440", "CR 501", "I-78") isn't a local name.
ROUTE_RE = (
    r'^((US|RT|NJ|SR|CR|I|ROUTE|INTERSTATE|HWY|STATE HWY|COUNTY RD|CO RD)[ -]?\d+(IV|I{1,3}|[A-Z])?'
    r'|[A-Z]+( [A-Z]+)? COUNTY( RD| ROUTE)? \d+(IV|I{1,3}|[A-Z])?)'
    r'( (N|S|E|W|NB|SB|EB|WB|RAMP|SPUR|BUS|UPPER|LOWER|EXPRESS|LOCAL|ALT|TRUCK|BYP|I|II|III|IV|\d|SECONDARY|WESTERN|EASTERN'
    r'|ALIGNMENT|(N J |NJ )?TPKE(-[NSEW])?))*$'
)


def alias_candidates(road: pd.Series) -> pd.Series:
    """Local-name candidates in crash-reported `road` strings, normalized, one row per candidate
    (index = the source row): the parenthetical part where there is one ("US 1 (Tonnelle Avenue)"
    → "TONNELLE AVE"), else the string itself; junk characters stripped, bare route designations
    dropped. Intersection-style values ("DUNCAN AVE / W SIDE AVE", "A ST & B ST") are dropped: either
    part may be the cross street, so they'd make cross streets look like aliases."""
    r = road.dropna().astype('string')
    paren = r.str.extract(r'\(([^)]+)\)', expand=False)
    r = paren.where(paren.notna(), r)
    parts = r[~r.str.contains(r'[/&]|\bAND\b', case=False, regex=True)]
    parts = parts.str.replace(r"[^A-Za-z0-9 '\-]", ' ', regex=True)
    parts = norm_name(parts)
    return parts[parts.notna() & (parts.str.len() > 2) & ~parts.str.match(ROUTE_RE).fillna(False)]


def top_aliases(crashes: pd.DataFrame, keys: list[str], k: int, min_n: int) -> pd.DataFrame:
    """Top-`k` local-name candidates (`alias_candidates`) per `keys` group (seen ≥ `min_n` times),
    as `keys + [alias, n, n_cand]` rows (`n_cand`: the group's crashes with any candidate), most
    common first (ties by name)."""
    cand = alias_candidates(crashes['road'])
    c = crashes[keys].loc[cand.index].assign(alias=cand.to_numpy())
    n = c.groupby(keys + ['alias']).size().rename('n').reset_index()
    n['n_cand'] = n.groupby(keys)['n'].transform('sum')
    n = n[n['n'] >= min_n].sort_values(keys + ['n', 'alias'], ascending=[True] * len(keys) + [False, True])
    return n.groupby(keys, sort=False).head(k).reset_index(drop=True)


def stretch_aliases(geom: pd.DataFrame, point_run: np.ndarray, by_entity: pd.DataFrame, min_n: int = ALIAS_MIN_N) -> pd.DataFrame:
    """Per stretch (`run`, ½-mile MP `bin`): its *dominant* crash-reported local name — the top
    `alias_candidates` string, seen ≥ `min_n` times and ≥ `ALIAS_DOMINANT_FRAC` of the stretch's
    candidate strings. Rows `(run, bin, alias, n, ng)`, `ng` = whether most of the stretch's points
    are NG911-named (`seg` ≥ 0; false when `geom` has no `seg`). A cross street reported as the
    `road` on some crashes (e.g. "PARK AVE" on Boulevard East) is a minority string on every
    stretch, so it's never dominant."""
    c = by_entity[['run', 'mp', 'road']].assign(bin=np.floor(by_entity['mp'] * 2) / 2)
    top = top_aliases(c, ['run', 'bin'], k=1, min_n=min_n)
    top = top[top['n'] >= ALIAS_DOMINANT_FRAC * top['n_cand']]
    named = geom['seg'].to_numpy() >= 0 if 'seg' in geom else np.zeros(len(geom), dtype=bool)
    ng = (
        pd.DataFrame({'run': point_run, 'bin': np.floor(geom['mp'].to_numpy() * 2) / 2, 'named': named})
        .groupby(['run', 'bin'])['named'].mean().ge(0.5).rename('ng').reset_index()
    )
    top = top.merge(ng, on=['run', 'bin'], how='left')
    top['ng'] = top['ng'].fillna(False).astype(bool)
    return top[['run', 'bin', 'alias', 'n', 'ng']].reset_index(drop=True)


def point_aliases(geom: pd.DataFrame, point_run: np.ndarray, stretches: pd.DataFrame) -> pd.Series:
    """Per `geom` point: its stretch's dominant crash-reported name (`stretch_aliases`), where
    that isn't just the point's own `name`."""
    pts = pd.DataFrame({'run': point_run, 'bin': np.floor(geom['mp'].to_numpy() * 2) / 2, 'name': norm_name(geom['name']).to_numpy()})
    merged = pts.merge(stretches[['run', 'bin', 'alias']], on=['run', 'bin'], how='left')
    alias = merged['alias'].astype('string')
    return alias.where(alias != merged['name']).set_axis(geom.index)


def entity_table(
    runs: pd.DataFrame,
    geom: pd.DataFrame,
    by_entity: pd.DataFrame,
    con: duckdb.DuckDBPyConnection,
    names: pd.DataFrame | None = None,
    point_run: np.ndarray | None = None,
    stretches: pd.DataFrame | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """One row per entity: `name` (the local name covering most of it), `route` (its route
    designations — NG911 shields, e.g. "CR 501", "US 1 / US 9" — else the SLD route name where it
    differs from `name`), min road class `subt`, `sris` (comma-joined), bbox, crash counts,
    `aliases` (NG911 local aliases, then crash-reported names of stretches NG911 doesn't name; " · "-joined, none
    equal to `name` after `name_key`), `cc` (county) and `munis` (" · "-joined, most points first).

    `names` is `njdot.road_net.run_names` output (per-run NG911 aliases / shields); `stretches` is
    `stretch_aliases` output (computed from `geom` / `point_run` / `by_entity` if not given). Also returns the
    entity's searchable names, `(entity, kind, name_display)` with `kind` "primary" / "alias" /
    "route", for `road_names_index`."""
    con.register('r', runs.assign(n=runs['mp_hi'] - runs['mp_lo'] + 0.1))
    muni = geom['muni'] if 'muni' in geom else pd.Series(pd.NA, index=geom.index, dtype='string')
    con.register('g', geom[['entity', 'lon', 'lat']].assign(muni=muni))
    con.register('c', by_entity[['entity', 'severity', 'tk']])
    cc = 'min(cc)::TINYINT' if 'cc' in runs else 'NULL::TINYINT'
    out = con.sql(f"""
        WITH names AS (
            SELECT entity, arg_max(name, n) AS name, arg_max(sld_name, n) AS sld_name, min(subt) AS subt,
                   string_agg(DISTINCT sri, ',' ORDER BY sri) AS sris, {cc} AS cc
            FROM r GROUP BY entity
        ), bbox AS (
            SELECT entity, min(lon) lon_min, min(lat) lat_min, max(lon) lon_max, max(lat) lat_max FROM g GROUP BY entity
        ), munis AS (
            SELECT entity, string_agg(muni, ' · ' ORDER BY n DESC, muni) AS munis
            FROM (SELECT entity, muni, count(*) n FROM g WHERE muni IS NOT NULL GROUP BY ALL) GROUP BY entity
        ), counts AS (
            SELECT entity, count(*)::INT n_crashes, count_if(severity = 'f')::INT n_fatal,
                   count_if(severity = 'i')::INT n_injury, coalesce(sum(tk), 0)::INT n_killed
            FROM c GROUP BY entity
        )
        SELECT n.entity, n.name, n.sld_name, n.subt, n.sris, b.lon_min, b.lat_min, b.lon_max, b.lat_max,
               coalesce(k.n_crashes, 0)::INT n_crashes, coalesce(k.n_fatal, 0)::INT n_fatal,
               coalesce(k.n_injury, 0)::INT n_injury, coalesce(k.n_killed, 0)::INT n_killed, n.cc, m.munis
        FROM names n JOIN bbox b USING (entity) LEFT JOIN counts k USING (entity) LEFT JOIN munis m USING (entity)
        ORDER BY n.entity
    """).df()
    for t in ('r', 'g', 'c'):
        con.unregister(t)
    name_mk = pd.Series(merge_key(out['name']).to_numpy(), index=out['entity'])

    # NG911 facts per entity, weighted by points covered.
    n_named = pd.Series(dtype='int64')
    if point_run is not None and 'seg' in geom:
        n_named = pd.Series(runs['entity'].to_numpy()[point_run][geom['seg'].to_numpy() >= 0]).value_counts()
    if names is not None and len(names):
        en = names.assign(entity=runs['entity'].to_numpy()[names['run']])
        en = en.groupby(['entity', 'kind', 'value'], as_index=False)['n'].sum()
        en = en.sort_values(['entity', 'kind', 'n', 'value'], ascending=[True, True, False, True])
    else:
        en = pd.DataFrame({'entity': pd.Series(dtype='int32'), 'kind': pd.Series(dtype='string'), 'value': pd.Series(dtype='string'), 'n': pd.Series(dtype='int64')})
    # Entity-level NG911 aliases: those covering ≥ `ENTITY_ALIAS_FRAC` of the entity's named points
    # (span-scoped ones, like "Journal Square" on a stretch of JFK Blvd, are only in the search index).
    ng_l = en[en['kind'] == 'L'].copy()
    ng_l['k'] = merge_key(ng_l['value']).to_numpy()
    ng_l = ng_l[ng_l['k'].to_numpy() != name_mk.loc[ng_l['entity']].to_numpy()]
    ng_l = ng_l.drop_duplicates(['entity', 'k'])
    ng_l = ng_l[ng_l['n'].to_numpy() >= ENTITY_ALIAS_FRAC * ng_l['entity'].map(n_named).to_numpy()]
    ng_l = ng_l.groupby('entity', sort=False).head(NG_ALIASES_MAX)
    shields = en[en['kind'] == 'shield'].groupby('entity', sort=False).head(ROUTES_MAX)
    routes = shields.groupby('entity')['value'].agg(' / '.join)
    # No shield: the SLD route name stands in for route-class roads (`subt` ≤ 6: interstate … county
    # routes), not for local streets (whose SLD name is just another street name).
    sld_route = out['sld_name'].astype('string').where((norm_name(out['sld_name']) != norm_name(out['name'])) & (out['subt'] <= 6))
    out['route'] = out['entity'].map(routes).astype('string').fillna(sld_route)

    # Crash-reported aliases: only a stretch's *dominant* crash-reported name (`stretch_aliases`), and
    # only on stretches NG911 doesn't name (where it does, crash strings add spelling variants and
    # cross streets, not names); summed per entity, they must account for ≥ `ALIAS_MIN_FRAC` of its
    # crashes (and ≥ `ALIAS_MIN_N`); variants of the entity's name / NG911 aliases aren't new.
    if stretches is None:
        stretches = stretch_aliases(geom, point_run, by_entity) if point_run is not None else pd.DataFrame(columns=['run', 'bin', 'alias', 'n', 'ng'])
    st = stretches[~stretches['ng'].astype(bool)]
    al = (
        st.assign(entity=runs['entity'].to_numpy()[st['run'].to_numpy(dtype=int)])
        .groupby(['entity', 'alias'], as_index=False)['n'].sum()
        .sort_values(['entity', 'n', 'alias'], ascending=[True, False, True])
    )
    al = al.merge(out[['entity', 'n_crashes']], on='entity')
    seen = set(zip(ng_l['entity'], merge_key(ng_l['value'])))
    al_k = merge_key(al['alias']).to_numpy()
    keep = (
        (al_k != name_mk.loc[al['entity']].to_numpy())
        & (al['n'] >= ALIAS_MIN_FRAC * al['n_crashes'])
        & np.array([(e, k) not in seen for e, k in zip(al['entity'], al_k)], dtype=bool)
    )
    al = al[keep].groupby('entity', sort=False).head(CRASH_ALIASES_MAX)
    both = pd.concat([ng_l[['entity', 'value']].assign(o=0), al[['entity', 'alias']].rename(columns={'alias': 'value'}).assign(o=1)])
    both = both.reset_index(drop=True).reset_index(names='i').sort_values(['entity', 'o', 'i'], kind='stable')
    out['aliases'] = out['entity'].map(both.groupby('entity')['value'].agg(' · '.join)).astype('string')
    cols = ['entity', 'name', 'route', 'subt', 'sris', 'lon_min', 'lat_min', 'lon_max', 'lat_max',
            'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases', 'cc', 'munis']
    out['cc'] = out['cc'].astype('Int8')
    out['munis'] = out['munis'].astype('string')

    # Entity-level searchable names (`road_names_index` adds span-scoped NG911 names from points).
    searchable = pd.concat([
        out[['entity', 'name']].rename(columns={'name': 'name_display'}).assign(kind='primary'),
        out[['entity', 'route']].dropna().assign(name_display=lambda d: d['route'].str.split(' / ')).explode('name_display')[['entity', 'name_display']].assign(kind='route'),
        al[['entity', 'alias']].rename(columns={'alias': 'name_display'}).assign(kind='alias'),
    ], ignore_index=True)
    return out[cols], searchable[['entity', 'kind', 'name_display']]


def point_names(geom: pd.DataFrame, seg: pd.DataFrame, aliases: pd.DataFrame) -> pd.DataFrame:
    """Per NG911-named point (`seg` ≥ 0): its searchable names, `(i, kind, name_display)` — the
    segment's name and local (`L`) aliases as "alias", its shield and route (`H`) aliases (full name
    and designation) as "route". `i` indexes `geom`."""
    pts = pd.DataFrame({'i': np.arange(len(geom)), 'seg': geom['seg'].to_numpy()})
    pts = pts[pts['seg'] >= 0]
    pts['rcl'] = seg['rcl'].to_numpy()[pts['seg']]
    out = [
        pts.assign(kind='alias', name_display=seg['name'].to_numpy()[pts['seg']]),
        pts.assign(kind='route', name_display=np.array(seg['shield'].to_numpy(), dtype=object)[pts['seg']]),
    ]
    a = pts.merge(aliases, on='rcl')
    out.append(a.assign(kind=np.where(a['kind'].eq('L'), 'alias', 'route'), name_display=a['alias']))
    out.append(a[a['kind'].eq('H')].assign(kind='route', name_display=lambda d: d['shield']))
    df = pd.concat([o[['i', 'kind', 'name_display']] for o in out], ignore_index=True)
    return df.dropna(subset=['name_display'])


KIND_ORDER = {'primary': 0, 'route': 1, 'alias': 2}
INDEX_COLS = [
    'name_display', 'name_norm', 'kind', 'entity', 'cc', 'munis', 'subt', 'n_crashes', 'lon', 'lat',
    'lon_min', 'lat_min', 'lon_max', 'lat_max',
]


def _spans(df: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    """`(entity, name_norm, name_display, o, lon, lat)` point rows → one row per `(entity,
    name_norm, o // 10)` (entity-level vs span rows): most common display, best (lowest) kind order, bbox, and the point nearest the bbox
    center (ties → southernmost, then westernmost)."""
    con.register('p', df)
    out = con.sql("""
        WITH b AS (
            SELECT entity, name_norm, o // 10 AS lvl, mode(name_display ORDER BY name_display) AS name_display, min(o) AS o,
                   min(lon) lon_min, min(lat) lat_min, max(lon) lon_max, max(lat) lat_max
            FROM p GROUP BY ALL
        )
        SELECT b.*, arg_min(p.lon, ((p.lon - (lon_min + lon_max) / 2) ^ 2 + (p.lat - (lat_min + lat_max) / 2) ^ 2, p.lat, p.lon)) AS lon,
                    arg_min(p.lat, ((p.lon - (lon_min + lon_max) / 2) ^ 2 + (p.lat - (lat_min + lat_max) / 2) ^ 2, p.lat, p.lon)) AS lat
        FROM b JOIN p ON p.entity = b.entity AND p.name_norm = b.name_norm AND p.o // 10 = b.lvl GROUP BY ALL
    """).df()
    con.unregister('p')
    return out


def road_names_index(
    ents: pd.DataFrame,
    searchable: pd.DataFrame,
    geom: pd.DataFrame,
    con: duckdb.DuckDBPyConnection,
    pt_names: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Searchable names (tokenized into `road-search` by `road_outputs.road_search_index`): one row per distinct `(entity, name_norm)` of non-ramp entities, `kind` by
    priority primary > route > alias; `name_display`, `name_norm` (`norm_name`: upper-case, abbreviated), `entity`,
    `cc`, `munis`, `subt`, `n_crashes`, a representative on-road point `lon` / `lat` (nearest the
    bbox center) and bbox. Entity-level names (`searchable`: primary, route designations,
    crash-reported aliases) get the entity's extent; NG911 names from `pt_names` (`point_names`) get
    the extent of *the points they're on*, so a span-scoped alias ("Journal Square" on JFK Blvd)
    locates its span, not the whole road. Sorted `(name_norm, entity)`."""
    ent_pts = pd.DataFrame({'entity': geom['entity'].to_numpy(), 'lon': geom['lon'].to_numpy(), 'lat': geom['lat'].to_numpy()})
    ent = searchable.dropna(subset=['name_display']).merge(ent_pts, on='entity')
    rows = [ent.assign(name_norm=norm_name(ent['name_display']).to_numpy(), o=ent['kind'].map(KIND_ORDER).to_numpy())]
    if pt_names is not None and len(pt_names):
        p = pt_names.assign(entity=geom['entity'].to_numpy()[pt_names['i']], lon=geom['lon'].to_numpy()[pt_names['i']], lat=geom['lat'].to_numpy()[pt_names['i']])
        # Span names rank after the entity-level ones for the same `(entity, name_norm)`.
        rows.append(p.assign(name_norm=norm_name(p['name_display']).to_numpy(), o=p['kind'].map(KIND_ORDER).to_numpy() + 10))
    df = pd.concat([r[['entity', 'name_norm', 'name_display', 'o', 'lon', 'lat']] for r in rows], ignore_index=True)
    df['name_display'] = df['name_display'].astype(str)
    df['name_norm'] = df['name_norm'].astype(str)
    df = _spans(df, con).sort_values(['entity', 'o', 'name_norm'], kind='stable')
    # Entity-level rows own their `(entity, name_norm)` (e.g. the primary: whole-entity extent).
    df = df.drop_duplicates(['entity', 'name_norm'])
    df['kind'] = df['o'].mod(10).map({v: k for k, v in KIND_ORDER.items()})
    df = df.merge(ents[['entity', 'cc', 'munis', 'subt', 'n_crashes']], on='entity')
    # Ramps (`subt` 8) are named by SLD descriptors ("FR RT 70 WB TO GSP SB"), not searched for.
    df = df[df['subt'] < 8]
    for c in ('lon', 'lat', 'lon_min', 'lat_min', 'lon_max', 'lat_max'):
        df[c] = df[c].astype('float32')
    df = df.sort_values(['name_norm', 'entity', 'o'], kind='stable').reset_index(drop=True)
    return df[INDEX_COLS].astype({'name_display': 'string', 'name_norm': 'string', 'kind': 'string'})


def write(
    df: pd.DataFrame,
    path: str,
    row_group_size: int,
    meta: dict[str, str] | None = None,
    level: int | None = None,
    stats: list[str] | None = None,
    dict_cols: list[str] | None = None,
):
    """Write `df` (zstd) in row groups of `row_group_size`. `stats`: write min/max statistics only
    for these columns (the ones queries filter on), which keeps the footer small when row groups
    are many; `dict_cols`: dictionary-encode only these columns; defaults: all.

    The footer's key-value metadata is `meta` only: no `pandas` / `ARROW:schema` blobs (2–9 KB per
    file, read by every first lookup). Readers get types from the Parquet schema alone, which
    DuckDB always does; pandas readers get plain dtypes back (nullable ints as float, strings as
    object)."""
    table = pa.Table.from_pandas(df, preserve_index=False).replace_schema_metadata(None)
    # `store_schema=False` also drops the schema's own metadata, so `meta` goes in via the writer.
    with pq.ParquetWriter(
        path, table.schema, compression='zstd', compression_level=level,
        write_statistics=stats if stats is not None else True,
        use_dictionary=(dict_cols or False) if dict_cols is not None else True,
        store_schema=False,
    ) as w:
        w.write_table(table, row_group_size=row_group_size)
        if meta:
            w.add_key_value_metadata(meta)
    err(f'  {path}: {len(df):,} rows, {os.path.getsize(path) / 2**20:.1f} MiB')


def build_geom(rn: pd.DataFrame, cl: pd.DataFrame, al: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> dict:
    """Sources → named MP points, runs, entities (no crashes). Returns a dict with `geom` (points,
    with `name`, `cc`, `muni`, `seg`, `entity`), `runs`, `point_run`, `names` (`run_names`),
    `seg`, `iv` (accepted NG911 intervals), `aliases` (`seg_aliases`), `parent` (secondary SRI → parent SRI),
    `feats` (`rn_features`)."""
    feats = rn_features(rn)
    err(f'  {len(feats):,} NJDOT line features, {feats["sri"].nunique():,} SRIs')
    geom = rn_points(feats)
    seg = ng_segments(cl)
    iv = ng_intervals(seg, feats)
    tagged = seg['tag'].notna() & seg['tag'].isin(set(feats['sri']))
    err(f'  {len(seg):,} NG911 segments ({int(tagged.sum()):,} tagged with a known SRI) → {len(iv):,} intervals '
        f'({int((iv["src"] == "tag").sum()):,} tag-checked, {int((iv["src"] == "snap").sum()):,} snapped)')
    geom = smooth_names(name_points(geom, iv, seg, con))
    err(f'  {len(geom):,} MP points, {(geom["seg"] >= 0).mean():.1%} named from NG911')
    runs, point_run = road_runs(geom)
    aliases = seg_aliases(al)
    names = run_names(geom, point_run, seg, aliases)
    parent = feats[feats['sec']].drop_duplicates('sri').set_index('sri')['parent'].to_dict()
    runs['entity'] = road_entities(runs, geom, point_run, names, parent)
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    return dict(geom=geom, runs=runs, point_run=point_run, names=names, seg=seg, iv=iv, aliases=aliases, parent=parent, feats=feats)


@njdot.group('roads')
def roads():
    """Road-selection artifacts (crashes / geometry by SRI and road entity)."""


# Bbox margin (degrees) around a county's NG911 segments when subsetting the NJDOT network (`county_subset`).
BBOX_PAD = 0.02


def county_subset(rn: pd.DataFrame, cl: pd.DataFrame, al: pd.DataFrame, cc: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Dev subsets: NG911 centerlines with either side in county `cc` (+ their aliases), and the
    NJDOT lines with a vertex within `BBOX_PAD`° of their bbox."""
    cl = cl[(cl['cc_l'] == cc) | (cl['cc_r'] == cc)].reset_index(drop=True)
    al = al[al['RCL_NGUID'].isin(set(cl['RCL_NGUID']))].reset_index(drop=True)
    xs, ys = np.concatenate(cl['x'].to_numpy()), np.concatenate(cl['y'].to_numpy())
    w, s, e, n = xs.min() - BBOX_PAD, ys.min() - BBOX_PAD, xs.max() + BBOX_PAD, ys.max() + BBOX_PAD
    rn = rn[[bool(((x >= w) & (x <= e) & (y >= s) & (y <= n)).any()) for x, y in zip(rn['x'], rn['y'])]].reset_index(drop=True)
    return rn, cl, al


def place_crashes(
    crashes: pd.DataFrame,
    latlon: pd.DataFrame,
    b: dict,
    cl: pd.DataFrame,
    al: pd.DataFrame,
    con: duckdb.DuckDBPyConnection,
    recover: bool = True,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Crashes (`load_build_crashes`) + their effective `lat` / `lon` (`_build_base`) + `build_geom`
    output → `(by_sri, by_entity)` for `road_outputs`. With `recover`, crashes their coded `(sri,
    mp)` doesn't put on an entity go through `njdot.loc_recovery` first (`recover_unassigned`,
    `fold_recovery`; specs/crash-location-recovery.md): placed ones join `by_sri` / `assign_crashes`
    with their recovered SRI / MP, `sri_only` / `name_only` ones are appended to `by_entity`."""
    extra = [c for c in LOC_COLS if c in crashes]
    if recover:
        t0 = time.monotonic()
        ctx = recovery_context(b['seg'], b['iv'], b['runs'], b['feats'], cl, al, cc2mc2mn)
        rec = recover_unassigned(crashes, ctx)
        crashes, latlon = fold_recovery(crashes, latlon, rec)
        counts = crashes['loc_source'].value_counts()
        err(f'  recovery ({time.monotonic() - t0:.0f}s, {len(rec):,} crashes tried): ' + ', '.join(f'{k} {v:,}' for k, v in counts.items()))
        # Crashes whose road meets the cross street at several junctions the offset / direction
        # doesn't choose between (`loc_recovery._locate_one`): on the road without a point, or on none.
        err(f'    ambiguous junctions: {int(rec["how"].eq("junctions").sum()):,} crashes')
        extra = ['loc_source', 'how', '_ent'] + extra
        b['idx'] = ctx['idx']
    else:
        b['idx'] = ng_name_index(cl, al, cc2mc2mn)
    by_sri = crashes_by_sri(crashes, latlon, extra)
    by_sri['_i'] = np.arange(len(by_sri), dtype='int64')
    by_entity = entity_crashes(by_sri, crashes, latlon, b['runs'], con)
    if '_cands' in crashes:
        # Crashes naming several roads, by `road_outputs` / `road_model.corridor_only_rows`.
        many = crashes['_cands'].notna().to_numpy()
        # (`crash_rows` makes object columns strings: the id tuples are set after.)
        b['cands'] = crash_rows(crashes[many], latlon, ['loc_source', 'how'] + LOC_COLS).assign(_cands=crashes.loc[many, '_cands'].to_numpy())
    return by_sri, by_entity


@roads.command('build')
@option('-c', '--crashes-by-sri', 'crashes_path', help='Reuse this `crashes-by-sri.parquet` instead of loading crashes (dev subsets; no recovery)')
@option('-C', '--county', 'cc', type=int, help='Dev subset: only this county\'s crashes, NG911 segments and nearby NJDOT lines')
@option('-g', '--ng911-dir', default=NG911_DIR, show_default=True, help='`njdot roads fetch-ng911` output dir')
@option('-n', '--network', default=ROADWAY_NETWORK, show_default=True, help='`njdot roads fetch-network` output')
@option('-N', '--notes', 'notes_path', default=ROAD_NOTES, show_default=True, help='Curated per-road data notes (YAML; see `njdot.road_notes`) → `road-notes.parquet`')
@option('-o', '--out-dir', default=ROADS_DIR, show_default=True, help='Output dir')
@option('-O', '--overrides', 'overrides_path', default=ROAD_OVERRIDES, show_default=True, help='Curated crash-assignment overrides (YAML; see `njdot.road_overrides`)')
@option('-R', '--no-recover', is_flag=True, help='Skip crash location recovery (coded SRI / MP only)')
def roads_build(crashes_path: str | None, cc: int | None, ng911_dir: str, network: str, notes_path: str, out_dir: str, overrides_path: str, no_recover: bool):
    """Build the `roads/` parquets (see module docstring)."""
    os.makedirs(out_dir, exist_ok=True)
    cl_path, al_path = join(ng911_dir, 'centerlines.parquet'), join(ng911_dir, 'aliases.parquet')
    err(f'Loading {network}, {cl_path}, {al_path}...')
    meta = {f'network_{k}': v for k, v in read_meta(network).items()} | {f'ng911_{k}': v for k, v in read_meta(cl_path).items()}
    rn, cl, al = pd.read_parquet(network), pd.read_parquet(cl_path), pd.read_parquet(al_path)
    if cc is not None:
        rn, cl, al = county_subset(rn, cl, al, cc)
    con = duckdb.connect()
    con.sql("SET memory_limit='12GB'; SET threads=4")
    steps = Steps('  ')
    err('Points, runs, entities...')
    b = build_geom(rn, cl, al, con)
    steps('points, runs, entities')
    del rn
    overrides = load_overrides(overrides_path)
    recode_counts: dict[str, int] = {}
    muni_counts = None
    if crashes_path:
        # A previous build's `crashes-by-sri` carries its (now stale) `entity`; it has no uncoded
        # crashes to recover.
        by_sri = read_crashes_by_sri(crashes_path).drop(columns=['entity', 'loc_source', 'how'], errors='ignore')
        if cc is not None:
            by_sri = by_sri[by_sri['cc'] == cc].reset_index(drop=True)
        by_sri['_i'] = np.arange(len(by_sri), dtype='int64')
        by_entity = assign_crashes(by_sri, b['runs'], con)
        # No police location fields here: crashes join nodes by cross street + point (as AASHTO's).
        b['idx'] = ng_name_index(cl, al, cc2mc2mn)
    else:
        err('Loading crashes...')
        crashes = load_build_crashes(cc)
        latlon = _build_base(crashes, keep_severities=set())
        steps('load crashes')
        # Crashes per muni-year-month, for `road_notes.muni_gaps` (towns whose reports are missing
        # some years; near-empty months).
        mcc = crashes.dropna(subset=['cc', 'mc'])
        muni_counts = mcc.groupby([mcc['cc'].astype(int), mcc['mc'].astype(int), 'year', mcc['dt'].dt.month.rename('month')], dropna=False).size().rename('n').reset_index()
        del mcc
        crashes, recode_counts = apply_recodes(crashes, overrides)
        for rid, n in recode_counts.items():
            err(f'  recode override {rid}: {n:,} crashes')
        by_sri, by_entity = place_crashes(crashes, latlon, b, cl, al, con, recover=not no_recover)
        del crashes, latlon
        steps('place crashes (incl. recovery)')
    o = road_outputs(b, by_sri, by_entity, con, cc2mc2mn, overrides, load_notes(notes_path), muni_counts)
    o['override_counts'] = recode_counts | o['override_counts']
    steps('road outputs')
    n_unpl = int(unplaced(o['by_entity']).sum())
    err(f'  {len(b["runs"]):,} runs → {len(o["ents"]):,} entities; {len(o["by_entity"]):,} crashes on an entity ({n_unpl:,} without a map point), {len(by_sri):,} with an SRI')
    err('Writing...')
    write_outputs(o, out_dir, meta)
    steps('write')


def road_outputs(
    b: dict,
    by_sri: pd.DataFrame,
    by_entity: pd.DataFrame,
    con: duckdb.DuckDBPyConnection,
    cc2mc2mn: CC2MC2MN,
    overrides: list[Override] | None = None,
    notes: list[Note] | None = None,
    muni_counts: pd.DataFrame | None = None,
) -> dict:
    """`build_geom` output + crashes (`by_sri` with a row index `_i`, `assign_crashes` output) → the
    output tables (keys = file names, plus `ents` / `by_entity` / `geom` / `runs` / `capped` /
    `override_counts`), with entity ids renumbered in slug order (`road_outputs.slug_order`), the
    curated `overrides` applied (`njdot.road_overrides`), the curated `notes` and the coverage gaps
    found in `muni_counts` (`cc, mc, year, month, n`: all crashes per muni-year-month) attached (`njdot.road_notes`
    → `road-notes`), and the v5 model (`njdot.road_model`:
    chainage, corridors, intersection nodes, blocks; specs/road-model-v5.md). Updates `b`'s `geom`
    / `runs` and `by_sri` (adds `entity`, drops `_i`) in place."""
    steps = Steps()
    geom, runs, point_run = b['geom'], b['runs'], b['point_run']
    # Crash-reported aliases come from crashes NJDOT placed itself: recovered ones were placed *by*
    # their names, so they'd only echo them back.
    coded = by_entity[by_entity['loc_source'].eq('sri_mp').fillna(False).to_numpy()] if 'loc_source' in by_entity else by_entity
    stretches = stretch_aliases(geom, point_run, coded.assign(run=coded['run'].astype('int64')))
    geom['alias'] = point_aliases(geom, point_run, stretches)
    ents, searchable = entity_table(runs, geom, by_entity, con, b['names'], point_run, stretches)
    pt_mc = point_mc(geom, cc2mc2mn)
    slugs = entity_slugs(ents, runs, geom, pt_mc, cc2mc2mn)
    new = slug_order(slugs)
    ents = ents.merge(slugs, on='entity')
    for df in (geom, runs, by_entity, ents, searchable):
        df['entity'] = df['entity'].map(new).astype('int32')
    steps('entities, slugs')
    by_entity, override_counts = apply_overrides(by_entity, overrides or [], ents[['entity', 'slug']])
    for rid, n in override_counts.items():
        err(f'  override {rid}: {n:,} crashes')
    steps('overrides')
    t0 = time.monotonic()
    cands = b.get('cands')
    if cands is not None:
        cands = cands.assign(_cands=[tuple(sorted(new[e] for e in t if e in new)) for t in cands['_cands']])
    m = model_outputs(b, ents, by_entity, b.get('idx'), cands)
    by_entity = m['by_entity']
    n_at = int(by_entity['node'].notna().sum())
    err(f'  v5 model ({time.monotonic() - t0:.0f}s): {len(m["pieces"]):,} pieces, {len(m["corridors"]):,} corridors '
        f'({len(m["members"]):,} entities), {len(m["nodes"]):,} intersection nodes, {len(m["blocks"]):,} blocks; '
        f'{n_at:,} crashes at an intersection ({n_at / max(len(by_entity), 1):.1%})')
    steps.t = time.monotonic()
    # Unplaced crashes (no chain) last within their entity; placed ones in chain order.
    by_entity = (
        by_entity.assign(_u=unplaced(by_entity).to_numpy() | by_entity['chain'].isna().to_numpy())
        .sort_values(['entity', '_u', 'chain', 'dt', 'id'], kind='stable', na_position='last')
        .drop(columns=['_u']).reset_index(drop=True)
    )
    on_sri = by_entity[by_entity['_i'].notna().to_numpy()]
    by_sri['entity'] = pd.Series(on_sri['entity'].to_numpy(), index=on_sri['_i'].to_numpy(dtype='int64')).reindex(np.arange(len(by_sri))).astype('Int32').array
    by_sri.drop(columns=['_i', '_ent'] + LOC_COLS, inplace=True, errors='ignore')
    by_entity.drop(columns=['run', '_i', 'how'], inplace=True, errors='ignore')
    # Counts after overrides.
    sev = by_entity['severity']
    cnt = by_entity[['entity', 'tk']].assign(
        _f=sev.eq('f').fillna(False).astype('int64').to_numpy(), _i=sev.eq('i').fillna(False).astype('int64').to_numpy(),
    ).groupby('entity').agg(n_crashes=('_f', 'size'), n_fatal=('_f', 'sum'), n_injury=('_i', 'sum'), n_killed=('tk', 'sum'))
    for c in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        ents[c] = ents['entity'].map(cnt[c]).fillna(0).astype('int32')
    lengths = entity_lengths(geom, pt_mc, b.get('parent', {}), RUN_GAP_MP, RUN_JUMP_M)
    ents['length_mi'] = ents['entity'].map(lengths['total']).fillna(0).astype('float32')
    subt = ents.set_index('entity')['subt']
    xs = xs_rows(by_entity, m['node_ents'], subt)
    # Each placed crash row's block (at a node: the block starting there; specs/road-model-v5.md § v5.1).
    by_entity['block'] = block_of(m['blocks'], by_entity['entity'], block_pos(by_entity, m['node_ents']))
    xs['block'] = block_of(m['blocks'], xs['entity'], xs['chain'])
    ents = ents.sort_values('entity').reset_index(drop=True)
    ents = ents_v5(ents, m, xs)
    steps('counts, lengths, xs rows')
    names_idx = road_names_index(ents[ENTITY_COLS], searchable, geom, con, point_names(geom, b['seg'], b['aliases']) if 'seg' in b else None)
    search, capped = road_search_index(names_idx, ents[ENTITY_COLS], cc2mc2mn)
    steps('search')
    nodes, node_ents = node_table(m['nodes'], m['node_ents'], m['node_legs'], b['seg'] if 'seg' in b else pd.DataFrame({'name': []}), ents, by_entity)
    blocks = blocks_v5(m['blocks'], by_entity, node_ents, xs)
    corridors, cor_summary, cor_summary_m = corridors_v5(m['corridors'], m['members'], ents, by_entity, xs, geom)
    notes = list(notes or [])
    if muni_counts is not None and len(muni_counts):
        gaps = gap_notes(muni_gaps(muni_counts), notes, {(c, mc): f'{mn}' for c, cty in cc2mc2mn.items() for mc, mn in cty.mc2mn.items()})
        err(f'  coverage gaps: {len(gaps)} muni-year runs ({", ".join(g.id for g in gaps[:12])}{", …" if len(gaps) > 12 else ""})')
        notes += gaps
    ent_munis = pd.DataFrame({'entity': geom['entity'].to_numpy(), 'cc': geom['cc'].astype('Int64').fillna(-1).to_numpy(), 'mc': pt_mc})
    ent_munis = ent_munis[(ent_munis['mc'] >= 0) & (ent_munis['cc'] >= 0)].drop_duplicates()
    notes_df = road_notes(notes, ents, m['members'].set_index('entity')['corridor'], ent_munis)
    steps('nodes, blocks, corridors, notes')
    return {
        'geom': geom, 'runs': runs, 'ents': ents, 'by_entity': by_entity, 'by_sri': by_sri, 'xs': xs,
        'road-summary': road_summary(by_entity, xs=xs), 'road-summary-monthly': road_summary(by_entity, monthly=True, xs=xs),
        'road-ranks': road_ranks(by_entity, ents, lengths), 'road-search': search, 'capped': capped,
        'road-pieces': m['pieces'], 'road-blocks': blocks, 'road-nodes': nodes, 'road-node-entities': node_ents,
        'road-corridors': corridors, 'road-corridor-summary': cor_summary, 'road-corridor-summary-monthly': cor_summary_m,
        'road-notes': notes_df, 'members': m['members'], 'pairs': m['pairs'],
        'override_counts': override_counts, 'node_legs': m['node_legs'], 'seg_ent': m['seg_ent'], 'node_ents_raw': m['node_ents'],
    }


def ents_v5(ents: pd.DataFrame, m: dict, xs: pd.DataFrame) -> pd.DataFrame:
    """`road-entities`' v5 columns: `corridor` / `corridor_c0` / `corridor_sign` (null when in no
    corridor; `cchain = corridor_c0 + corridor_sign · chain`), `chain_mi` (the chain's end), `n_nodes`,
    and the other roads' crashes at its intersections, `n_crashes_xs` / `n_fatal_xs` / `n_injury_xs` /
    `n_killed_xs` (inclusive = `n_*` + `n_*_xs`)."""
    mem = m['members'].set_index('entity')
    out = ents.copy()
    out['corridor'] = out['entity'].map(mem['corridor']).astype('Int32')
    out['corridor_c0'] = out['entity'].map(mem['c0']).astype('float32')
    out['corridor_sign'] = out['entity'].map(mem['sign']).astype('Int8')
    out['chain_mi'] = out['entity'].map(m['pieces'].groupby('entity')['chain_hi'].max()).fillna(0).astype('float32')
    out['n_nodes'] = out['entity'].map(m['node_ents'].groupby('entity').size()).fillna(0).astype('int32')
    xc = _xs_counts(xs, 'entity')
    for c in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        out[f'{c}_xs'] = out['entity'].map(xc[c]).fillna(0).astype('int32')
    return out[ENTITY_COLS + ENTITY_V5_COLS]


def _xs_counts(xs: pd.DataFrame, key: str) -> pd.DataFrame:
    c = xs.assign(_f=xs['severity'].eq('f').astype('int32'), _i=xs['severity'].eq('i').astype('int32'), _k=pd.to_numeric(xs['tk'], errors='coerce').fillna(0).astype('int32'))
    return c.groupby(key).agg(n_crashes=('_f', 'size'), n_fatal=('_f', 'sum'), n_injury=('_i', 'sum'), n_killed=('_k', 'sum'))


def blocks_v5(blocks: pd.DataFrame, by_entity: pd.DataFrame, node_ents: pd.DataFrame, xs: pd.DataFrame) -> pd.DataFrame:
    """`road-blocks`: `road_model.block_stats` (the road's own crashes, and other roads' crashes at
    its intersections, by their `block`) + `from_name` / `to_name` (the cross streets at each end's
    node, from `road-node-entities.cross`) and `length_mi`."""
    b = block_stats(blocks, by_entity, xs)
    cross = node_ents[['entity', 'node', 'cross']].astype({'entity': 'int64', 'node': 'int64'}).drop_duplicates(['entity', 'node'])

    def names(col):
        k = pd.DataFrame({'entity': b['entity'].astype('int64').to_numpy(), 'node': b[col].astype('Int64').to_numpy()})
        return pd.array(k.merge(cross, on=['entity', 'node'], how='left')['cross'].to_numpy(dtype=object, na_value=None), dtype='string')
    b['from_name'] = names('node_lo')
    b['to_name'] = names('node_hi')
    b['length_mi'] = (b['chain_hi'] - b['chain_lo']).astype('float32')
    b = b.astype({'chain_lo': 'float32', 'chain_hi': 'float32'})
    return b[BLOCK_COLS]


BLOCK_COLS = [
    'entity', 'block', 'chain_lo', 'chain_hi', 'length_mi', 'node_lo', 'node_hi', 'from_name', 'to_name',
    'n_crashes', 'n_fatal', 'n_injury', 'n_killed',
    # v5.1
    'n_crashes_xs', 'n_fatal_xs', 'n_injury_xs', 'n_killed_xs',
]


def corridors_v5(corridors: pd.DataFrame, members: pd.DataFrame, ents: pd.DataFrame, by_entity: pd.DataFrame, xs: pd.DataFrame, geom: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """`road-corridors` (one row per corridor: slug, name, kind, members, extent, counts),
    `road-corridor-summary` (per `(corridor, year, severity)`, as `road-summary`; `n_xs` counts
    crashes at the corridor's intersections on roads *outside* it, once per crash) and
    `road-corridor-summary-monthly` (the same per `(corridor, year, month, severity)`)."""
    e = ents.set_index('entity')
    mem = members.merge(ents[['entity', 'slug']], on='entity')
    cor = corridors.set_index('corridor')
    ent_list = mem.sort_values(['corridor', 'role', 'slug']).groupby('corridor')['entity'].agg(lambda s: ','.join(map(str, s)))
    c_of = members.set_index('entity')['corridor']
    be = by_entity.assign(corridor=by_entity['entity'].map(c_of))
    be = be[be['corridor'].notna().to_numpy()].assign(corridor=lambda d: d['corridor'].astype('int32'))
    x = xs.assign(corridor=xs['entity'].map(c_of), own_c=xs['own_entity'].map(c_of))
    x = x[x['corridor'].notna().to_numpy() & (x['corridor'] != x['own_c']).fillna(True).to_numpy()]
    x = x.assign(corridor=x['corridor'].astype('int32'))
    x = x.drop_duplicates(['corridor', 'year', 'case', 'dt', 'cc', 'mc', 'own_entity'])
    cnt = _xs_counts(be.rename(columns={}), 'corridor')
    xc = _xs_counts(x, 'corridor')
    gm = geom[geom['entity'].isin(members['entity'])].assign(corridor=lambda d: d['entity'].map(c_of))
    bbox = gm.groupby('corridor').agg(lon_min=('lon', 'min'), lat_min=('lat', 'min'), lon_max=('lon', 'max'), lat_max=('lat', 'max'))
    out = corridors[['corridor', 'slug', 'name', 'kind']].astype({'corridor': 'int32'})
    out['spine'] = out['corridor'].map(cor['spine']).astype('int32')
    out['entities'] = out['corridor'].map(ent_list).astype('string')
    out['n_entities'] = out['corridor'].map(members.groupby('corridor').size()).astype('int16')
    out['cc'] = out['corridor'].map(mem.assign(cc=mem['entity'].map(e['cc'])).groupby('corridor')['cc'].agg(lambda s: s.iloc[0] if s.nunique() == 1 else pd.NA)).astype('Int8')
    out['chain_mi'] = out['corridor'].map(cor['chain_mi']).astype('float32')
    out['length_mi'] = out['corridor'].map(cor['length_mi']).astype('float32')
    for c in ('lon_min', 'lat_min', 'lon_max', 'lat_max'):
        out[c] = out['corridor'].map(bbox[c])
    for c in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        out[c] = out['corridor'].map(cnt[c]).fillna(0).astype('int32')
        out[f'{c}_xs'] = out['corridor'].map(xc[c]).fillna(0).astype('int32')
    summ = road_summary(be, xs=x, key='corridor')
    summ_m = road_summary(be, monthly=True, xs=x, key='corridor')
    return out.sort_values('corridor').reset_index(drop=True), summ, summ_m


# `crashes-by-entity` / `crashes-by-entity-xs` columns (v4's, then v5's), where present.
BY_ENTITY_COLS = [
    'entity', 'sri', 'mp', 'id', 'year', 'dt', 'cc', 'mc', 'case', 'severity', 'tk', 'ti', 'pk', 'pi', 'tv',
    'road', 'cross_street', 'route', 'loc_source', 'lat', 'lon',
    'chain', 'chain_lo', 'chain_hi', 'node', 'override',
]
# v5.1 (specs/road-model-v5.md § v5.1), last (after `crashes-by-entity-xs`' `own_entity` too).
BY_ENTITY_V51_COLS = ['block', 'corridor_only']
V5_FILES = [
    'road-pieces', 'road-blocks', 'road-nodes', 'road-node-entities', 'road-corridors', 'road-corridor-summary',
    'road-corridor-summary-monthly',
    # specs/road-anomalies.md § Data notes.
    'road-notes',
]


def write_outputs(o: dict, out_dir: str, meta: dict[str, str]):
    """Write `road_outputs` output to `out_dir` (and remove `STALE` files there)."""
    geom = o['geom'][['sri', 'mp', 'sld_name', 'name', 'subt', 'entity', 'alias', 'lon', 'lat'] + (['chain'] if 'chain' in o['geom'] else [])]
    # `sri-geom` is read per road (`WHERE entity = ?`), so it's sorted by entity: a road's points
    # are contiguous. `sri-hit*` / `sris` re-sort / aggregate `geom` themselves.
    by_entity_geom = geom.sort_values(['entity', 'sri', 'mp'], kind='stable').reset_index(drop=True)
    be = o['by_entity']
    write(o['by_sri'], join(out_dir, 'crashes-by-sri.parquet'), ROW_GROUP['crashes-by-sri'])
    write(be[[c for c in BY_ENTITY_COLS + BY_ENTITY_V51_COLS if c in be]], join(out_dir, 'crashes-by-entity.parquet'), ROW_GROUP['crashes-by-entity'], stats=STATS['crashes-by-entity'], dict_cols=DICT['crashes-by-entity'])
    if 'xs' in o:
        xs = o['xs'].sort_values(['entity', 'chain', 'dt', 'id'], kind='stable').reset_index(drop=True)
        cols = [c for c in BY_ENTITY_COLS if c in xs] + ['own_entity'] + [c for c in BY_ENTITY_V51_COLS if c in xs]
        write(xs[cols].astype({'own_entity': 'int32'}), join(out_dir, 'crashes-by-entity-xs.parquet'),
              ROW_GROUP['crashes-by-entity-xs'], stats=STATS['crashes-by-entity-xs'], dict_cols=DICT['crashes-by-entity-xs'])
    write(by_entity_geom, join(out_dir, 'sri-geom.parquet'), ROW_GROUP['sri-geom'], meta, stats=STATS['sri-geom'])
    hit = sri_hit(geom.drop(columns=['chain'], errors='ignore'))
    write(hit, join(out_dir, 'sri-hit.parquet'), ROW_GROUP['sri-hit'])
    for tier in HIT_TIERS:
        write(hit[hit['subt'] <= tier].reset_index(drop=True), join(out_dir, f'sri-hit-{tier}.parquet'), ROW_GROUP['sri-hit'])
    write(sris(geom, o['by_sri']), join(out_dir, 'sris.parquet'), ROW_GROUP['sris'])
    ents_meta = meta | ({'overrides': json.dumps(o['override_counts'], separators=(',', ':'), sort_keys=True)} if o.get('override_counts') else {})
    write(o['ents'], join(out_dir, 'road-entities.parquet'), ROW_GROUP['road-entities'], ents_meta, stats=STATS['road-entities'], dict_cols=DICT['road-entities'])
    write(o['runs'][['entity', 'sri', 'mp_lo', 'mp_end']].sort_values(['entity', 'sri', 'mp_lo']).reset_index(drop=True),
          join(out_dir, 'road-runs.parquet'), ROW_GROUP['road-runs'], stats=STATS['road-runs'])
    for f in ('road-summary', 'road-summary-monthly', 'road-ranks') + tuple(f for f in V5_FILES if f in o):
        write(o[f], join(out_dir, f'{f}.parquet'), ROW_GROUP[f], stats=STATS[f], dict_cols=DICT.get(f))
    write(o['road-search'], join(out_dir, 'road-search.parquet'), ROW_GROUP['road-search'], meta | search_meta(o['capped']), stats=STATS['road-search'], dict_cols=DICT['road-search'])
    for f in STALE:
        if exists(join(out_dir, f)):
            os.remove(join(out_dir, f))
            err(f'  removed {join(out_dir, f)} (no longer built)')


def parse_bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    return tuple(float(v) for v in bbox.split(',')) if bbox else None


@roads.command('fetch-network')
@option('-b', '--bbox', help='Only features intersecting this `w,s,e,n` lon/lat box (dev subsets)')
@option('-o', '--out', default=ROADWAY_NETWORK, show_default=True, help='Output parquet')
@option('-w', '--where', default='1=1', show_default=True, help='ArcGIS `where` clause')
def fetch_network_cmd(bbox: str | None, out: str, where: str):
    """Fetch the NJDOT Roadway Network (SRI lines with milepost M-values)."""
    df, meta = fetch_network(where=where, bbox=parse_bbox(bbox))
    os.makedirs(dirname(out) or '.', exist_ok=True)
    write_parquet(df, out, meta)


@roads.command('fetch-ng911')
@option('-b', '--bbox', help='Only segments intersecting this `w,s,e,n` lon/lat box (dev subsets)')
@option('-o', '--out-dir', default=NG911_DIR, show_default=True, help='Output dir (`centerlines.parquet`, `aliases.parquet`)')
@option('-w', '--where', default='1=1', show_default=True, help=f"ArcGIS `where` clause (e.g. Hudson: \"COUNTY_L='{HUDSON_GNIS}' OR COUNTY_R='{HUDSON_GNIS}'\")")
def fetch_ng911_cmd(bbox: str | None, out_dir: str, where: str):
    """Fetch NJOGIS NG9-1-1 road centerlines + their name aliases."""
    cl, al, cl_meta, al_meta = fetch_ng911(where=where, bbox=parse_bbox(bbox))
    os.makedirs(out_dir, exist_ok=True)
    write_parquet(cl, join(out_dir, 'centerlines.parquet'), cl_meta)
    write_parquet(al, join(out_dir, 'aliases.parquet'), al_meta)


@roads.command('audit')
@option('-c', '--crashes-by-sri', 'crashes_path', default=join(ROADS_DIR, 'crashes-by-sri.parquet'), show_default=True, help='`crashes-by-sri.parquet`')
@option('-C', '--county', 'cc', type=int, default=9, show_default=True, help='County code (9 = Hudson)')
@option('-g', '--ng911-dir', default=NG911_DIR, show_default=True, help='`njdot roads fetch-ng911` output dir')
@option('-O', '--osm', 'osm_path', help='Overpass JSON (`out tags`) of the county\'s roads, to compare names against (never published)')
@option('-r', '--roads-dir', default=ROADS_DIR, show_default=True, help='`njdot roads build` output dir')
@option('-t', '--top', type=int, default=15, show_default=True, help='List this many top unmatched names')
def roads_audit(crashes_path: str, cc: int, ng911_dir: str, osm_path: str | None, roads_dir: str, top: int):
    """Name coverage of crash `road` strings by NG911 / SLD / (optionally) OSM names, for one county."""
    for line in audit(cc, ng911_dir, roads_dir, crashes_path, osm_path, top):
        print(line)


@roads.command('audit-anomalies')
@option('-m', '--markdown', 'md_path', help='Also write the top findings of each kind as markdown here')
@option('-n', '--top', type=int, default=25, show_default=True, help='Findings per kind in the markdown / printed summary')
@option('-o', '--out', 'csv_path', help='Write the full ranked review queue (CSV) here')
@option('-r', '--roads-dir', default=ROADS_DIR, show_default=True, help='`njdot roads build` output dir')
def roads_audit_anomalies(md_path: str | None, top: int, csv_path: str | None, roads_dir: str):
    """Rank roads whose crash counts look like data quirks: year-over-year breaks (of roads, and of
    corridors), crashes without a map point, and road pairs whose split of shared crashes swings by
    year (`njdot.road_anomalies`). Breaks a corridor absorbs or a data note (`road-notes`) explains
    are left out."""
    from njdot.road_anomalies import absorbed, corridor_yoy, noted, pair_swings, queue_markdown, review_queue, unplaced_share, yoy_breaks
    rd = lambda f, cols=None: pd.read_parquet(join(roads_dir, f), columns=cols)
    ents = rd('road-entities.parquet', ['entity', 'slug', 'name', 'cc', 'subt'])
    summary = rd('road-summary.parquet')
    ramps = set(ents.loc[ents['subt'] >= 8, 'entity'])
    summary = summary[~summary['entity'].isin(ramps)]
    yoy = yoy_breaks(summary, ents)
    if exists(join(roads_dir, 'road-notes.parquet')):
        # Breaks a data note already explains (a town's missing reports, a coding change).
        nt = noted(yoy, rd('road-notes.parquet'))
        err(f'Data notes explain {int(nt.sum()):,} of {len(yoy):,} `yoy` findings')
        yoy = yoy[~nt]
    parts = [unplaced_share(summary, ents)]
    # `pair_swing` / `corridor_yoy` need v5 outputs (intersection nodes, corridors).
    if exists(join(roads_dir, 'road-node-entities.parquet')):
        be = rd('crashes-by-entity.parquet', ['entity', 'year', 'node'])
        node_ents = rd('road-node-entities.parquet', ['entity', 'node'])
        members = rd('road-entities.parquet', ['entity', 'corridor']).dropna(subset=['corridor'])
        swings = pair_swings(be, node_ents, ents, members)
        cor = corridor_yoy(rd('road-corridor-summary.parquet'), rd('road-corridors.parquet', ['corridor', 'slug', 'name', 'cc']), summary, ents)
        ay, ap = absorbed(yoy, cor, members), absorbed(swings, cor, members)
        err(f'Corridors absorb {int(ay.sum()):,} of {len(yoy):,} `yoy` and {int(ap.sum()):,} of {len(swings):,} `pair_swing` findings (their corridor\'s series has no break then)')
        yoy, swings = yoy[~ay], swings[~ap]
        parts += [swings, cor]
    else:
        err(f'{roads_dir} has no `road-node-entities.parquet` (pre-v5 build): skipping `pair_swing`, `corridor_yoy`')
    q = review_queue([yoy] + parts)
    if csv_path:
        q.to_csv(csv_path, index=False)
        err(f'Wrote {len(q):,} findings to {csv_path}')
    md = queue_markdown(q, top)
    if md_path:
        with open(md_path, 'w') as f:
            f.write(md + '\n')
        err(f'Wrote {md_path}')
    else:
        print(md)


@roads.command('sync')
@option('-n', '--dry-run', is_flag=True, help='Show what would be uploaded without uploading')
@option('-u', '--s3-url', default=ROADS_S3, help=f'Sync to this S3 URL (default: {ROADS_S3})')
def roads_sync(dry_run: bool, s3_url: str):
    """Mirror `roads/` to `s3_url` (the map's road-selection fetches)."""
    cmd = ['aws', 's3', 'sync', ROADS_DIR, s3_url, '--delete']
    if dry_run:
        cmd.append('--dryrun')
    err(f'$ {" ".join(cmd)}')
    subprocess.run(cmd, env={**os.environ}, check=True)
