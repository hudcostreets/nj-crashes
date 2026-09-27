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
in the browser by DuckDB-WASM with ranged reads, so each is sorted for row-group pruning:

- `sri-geom.parquet`: points `(sri, mp, sld_name, name, subt, entity, alias, lon, lat)`, sorted
  `(sri, mp)`. `name` = the NG911 local street name (else the NJDOT `SLD_NAME`); `alias` = the most
  common crash-reported `road` in the point's ½-mile bin, where it differs from `name`.
- `sri-hit{-5,-6,}.parquet`: the same points sorted by S2 cell (level `HIT_S2_LEVEL`) so a viewport
  bbox prunes on row-group stats; `-5` / `-6` keep only road classes `subt` ≤ 5 / ≤ 6 (interstate
  … county), for hover at wider zooms.
- `road-entities.parquet`: one row per entity (local name, route designation, class, SRIs, bbox,
  counts, aliases, county, munis), sorted by `entity`.
- `road-runs.parquet`: `(entity, sri, mp_lo, mp_end)` intervals, sorted by `entity`.
- `road-names.parquet`: the ⌘K search index, one row per searchable name of an entity (`primary` /
  `alias` / `route`), sorted by `name_norm`.
- `crashes-by-entity.parquet`: crashes on an entity's runs, sorted `(entity, sri, mp, dt, id)`.
- `crashes-by-sri.parquet` / `sris.parquet`: the same by whole SRI route.
"""
import os
import subprocess
from os.path import dirname, join

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from click import option

from nj_crashes.utils.log import err
from njdot.load import load_crashes_with_aashto
from njdot.map_base import _build_base
from njdot.paths import NG911_DIR, ROADS_DIR, ROADS_S3, ROADWAY_NETWORK
from njdot.road_audit import audit
from njdot.road_net import (
    merge_key, name_points, ng_intervals, ng_segments, norm_name, rn_features, rn_points, road_entities,
    run_names, seg_aliases,
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
    'crashes-by-entity': 25_000,
    'sri-geom': 25_000,
    # Smaller groups → a click's bbox reads fewer bytes.
    'sri-hit': 8_000,
    'sris': 25_000,
    'road-entities': 25_000,
    'road-runs': 25_000,
    'road-names': 50_000,
}
M_PER_DEG_LAT = 110_540


def m_per_deg_lon(lat):
    return 111_320 * np.cos(np.radians(lat))


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
    out = con.sql("""
        SELECT r.entity, r.run, c.* FROM c JOIN r ON c.sri = r.sri AND c.mp >= r.mp_lo AND c.mp < r.mp_end
        ORDER BY r.entity, c.sri, c.mp, c.dt, c.id
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


KIND_ORDER = {'primary': 0, 'route': 1, 'alias': 2}


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
    """⌘K search index: one row per distinct `(entity, name_norm)` of non-ramp entities, `kind` by
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


def write(df: pd.DataFrame, path: str, row_group_size: int, meta: dict[str, str] | None = None, level: int | None = None):
    table = pa.Table.from_pandas(df, preserve_index=False)
    if meta:
        table = table.replace_schema_metadata({**(table.schema.metadata or {}), **{k.encode(): v.encode() for k, v in meta.items()}})
    pq.write_table(table, path, row_group_size=row_group_size, compression='zstd', compression_level=level, write_statistics=True)
    err(f'  {path}: {len(df):,} rows, {os.path.getsize(path) / 2**20:.1f} MiB')


def build_geom(rn: pd.DataFrame, cl: pd.DataFrame, al: pd.DataFrame, con: duckdb.DuckDBPyConnection) -> dict:
    """Sources → named MP points, runs, entities (no crashes). Returns a dict with `geom` (points,
    with `name`, `cc`, `muni`, `seg`, `entity`), `runs`, `point_run`, `names` (`run_names`),
    `seg`, `iv` (accepted NG911 intervals)."""
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
    return dict(geom=geom, runs=runs, point_run=point_run, names=names, seg=seg, iv=iv, aliases=aliases)


@njdot.group('roads')
def roads():
    """Road-selection artifacts (crashes / geometry by SRI and road entity)."""


@roads.command('build')
@option('-c', '--crashes-by-sri', 'crashes_path', help='Reuse this `crashes-by-sri.parquet` instead of loading crashes (dev subsets)')
@option('-g', '--ng911-dir', default=NG911_DIR, show_default=True, help='`njdot roads fetch-ng911` output dir')
@option('-n', '--network', default=ROADWAY_NETWORK, show_default=True, help='`njdot roads fetch-network` output')
@option('-o', '--out-dir', default=ROADS_DIR, show_default=True, help='Output dir')
def roads_build(crashes_path: str | None, ng911_dir: str, network: str, out_dir: str):
    """Build the `roads/` parquets (see module docstring)."""
    os.makedirs(out_dir, exist_ok=True)
    if crashes_path:
        by_sri = pd.read_parquet(crashes_path)
    else:
        err('Loading crashes...')
        crashes = load_crashes_with_aashto(columns=MAP_INPUT_COLS + ['id'])
        latlon = _build_base(crashes, keep_severities=set())
        by_sri = crashes_by_sri(crashes, latlon)
        del crashes, latlon
    cl_path, al_path = join(ng911_dir, 'centerlines.parquet'), join(ng911_dir, 'aliases.parquet')
    err(f'Loading {network}, {cl_path}, {al_path}...')
    meta = {f'network_{k}': v for k, v in read_meta(network).items()} | {f'ng911_{k}': v for k, v in read_meta(cl_path).items()}
    con = duckdb.connect()
    con.sql("SET memory_limit='12GB'; SET threads=4")
    err('Points, runs, entities...')
    b = build_geom(pd.read_parquet(network), pd.read_parquet(cl_path), pd.read_parquet(al_path), con)
    geom, runs, point_run = b['geom'], b['runs'], b['point_run']
    by_entity = assign_crashes(by_sri, runs, con)
    stretches = stretch_aliases(geom, point_run, by_entity)
    geom['alias'] = point_aliases(geom, point_run, stretches)
    ents, searchable = entity_table(runs, geom, by_entity, con, b['names'], point_run, stretches)
    names_idx = road_names_index(ents, searchable, geom, con, point_names(geom, b['seg'], b['aliases']))
    err(f'  {len(runs):,} runs → {len(ents):,} entities; {len(by_entity):,} of {len(by_sri):,} SRI crashes on an entity')
    err('Writing...')
    geom = geom[['sri', 'mp', 'sld_name', 'name', 'subt', 'entity', 'alias', 'lon', 'lat']]
    write(by_sri, join(out_dir, 'crashes-by-sri.parquet'), ROW_GROUP['crashes-by-sri'])
    write(by_entity.drop(columns=['run']), join(out_dir, 'crashes-by-entity.parquet'), ROW_GROUP['crashes-by-entity'])
    write(geom, join(out_dir, 'sri-geom.parquet'), ROW_GROUP['sri-geom'], meta)
    hit = sri_hit(geom)
    write(hit, join(out_dir, 'sri-hit.parquet'), ROW_GROUP['sri-hit'])
    for tier in HIT_TIERS:
        write(hit[hit['subt'] <= tier].reset_index(drop=True), join(out_dir, f'sri-hit-{tier}.parquet'), ROW_GROUP['sri-hit'])
    write(sris(geom, by_sri), join(out_dir, 'sris.parquet'), ROW_GROUP['sris'])
    write(ents, join(out_dir, 'road-entities.parquet'), ROW_GROUP['road-entities'], meta)
    write(runs[['entity', 'sri', 'mp_lo', 'mp_end']].sort_values(['entity', 'sri', 'mp_lo']).reset_index(drop=True),
          join(out_dir, 'road-runs.parquet'), ROW_GROUP['road-runs'])
    # Fetched whole by the ⌘K omnibar: squeeze it.
    write(names_idx, join(out_dir, 'road-names.parquet'), ROW_GROUP['road-names'], meta, level=19)


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
