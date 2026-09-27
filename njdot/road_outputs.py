"""Road-page / ranking / search outputs of `njdot roads build` (specs/road-data-v4.md):

- **Slugs** (`entity_slugs`): a stable, unique URL key per road entity, `<county>/<muni>/<road>` for a
  road within one muni, else `<county>/<road>`; entity ids are then renumbered in slug order
  (`slug_order`), so every entity-sorted file is also slug-sorted (county / muni prefixes contiguous).
- **Lengths** (`entity_lengths`): miles of road per entity, and per entity × county / muni.
- **Summaries** (`road_summary`): crash counts per `(entity, year[, month], severity)`.
- **Ranks** (`road_ranks`): each county's / muni's top roads by crashes, fatal crashes, killed, and
  crashes per mile, counting only the road's crashes *in* that county / muni.
- **Search** (`road_search_index`): a word index over the ⌘K names (`roads.road_names_index`), one row
  per `(token, name row)`, tokens canonicalized through `SYNONYMS` — which the frontend mirrors in
  `www/src/map/roads/roadSearch.ts` (and can read from `road-search.parquet`'s key-value metadata).
"""
import json
import re
import unicodedata

import numpy as np
import pandas as pd

from njdot.cc2mc2mn import CC2MC2MN
from njdot.road_net import M_PER_DEG_LAT, m_per_deg_lon

# --- Slugs -------------------------------------------------------------------------------------

# A road is "within one muni" (→ `<county>/<muni>/<road>`) if exactly one muni covers ≥ this share
# of its muni-tagged points (a sliver across a boundary doesn't make it a multi-muni road).
SLUG_MUNI_FRAC = 0.1
# Slug county segment for entities with no county (a few out-of-state / unattributed ramps).
NO_COUNTY_SLUG = 'nj'
MUNI_TYPES = {
    'township': 'twp', 'twp': 'twp', 'borough': 'boro', 'boro': 'boro', 'city': 'city', 'village': 'village',
    'town': 'town',
}
# NG911 muni names `muni_mc`'s rules can't resolve: `(cc, NG911 name)` → the `cc2mc2mn` name.
MUNI_OVERRIDES = {
    (14, 'Boonton'): 'Boonton Town',  # NG911 "Boonton" (the town) / "Boonton Township"
}


def site_slug(s: str) -> str:
    """The site's county / muni URL slug (`www/src/county.ts` `normalize`): lower-case, spaces →
    hyphens ("Egg Harbor Twp" → "egg-harbor-twp", as in `/map/atlantic/egg-harbor-twp`)."""
    return s.lower().replace(' ', '-')


def slugify(s: str | None) -> str:
    """A road name → URL slug: ASCII-folded, lower-case, apostrophes dropped, other runs of
    non-alphanumerics → "-" ("J F Kennedy Boulevard" → "j-f-kennedy-boulevard", "St. Paul's
    Avenue" → "st-pauls-avenue"); "road" if nothing is left."""
    if s is None or pd.isna(s):
        return 'road'
    a = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode('ascii').lower()
    a = re.sub(r"['’`]", '', a)
    a = re.sub(r'[^a-z0-9]+', '-', a).strip('-')
    return a or 'road'


def _muni_forms(name: str) -> list[str]:
    """Match keys of a muni name, most specific first: lower-case, no periods, a leading "City of" /
    "Town of" / … dropped, type words canonicalized ("Township" → "twp"), then with trailing type
    words stripped one at a time ("Neptune City Borough" → "neptune city boro", "neptune city", "neptune")."""
    w = name.lower().replace('.', '').split()
    if len(w) > 2 and w[1] == 'of' and w[0] in MUNI_TYPES:
        w = w[2:]
    w = [MUNI_TYPES.get(x, x) for x in w]
    forms = [' '.join(w)]
    while len(w) > 1 and w[-1] in MUNI_TYPES.values():
        w = w[:-1]
        forms.append(' '.join(w))
    return forms


def muni_codes(pairs: list[tuple[int, str]], cc2mc2mn: CC2MC2MN) -> dict[tuple[int, str], int]:
    """NG911 `(cc, muni name)` pairs → NJDOT muni codes (`cc2mc2mn`, the site's codes), for those that
    resolve: the NG911 name's most specific form (`_muni_forms`) that some of the county's munis
    share decides; among several, the muni it's the *most specific* form of wins ("Neptune
    Township" → Neptune, not Neptune City), and a tie is unresolved (→ `MUNI_OVERRIDES`)."""
    out = {}
    by_cc = {cc: {mc: _muni_forms(mn) for mc, mn in c.mc2mn.items()} for cc, c in cc2mc2mn.items()}
    for cc, name in pairs:
        if cc not in by_cc or name is None or pd.isna(name):
            continue
        if (cc, name) in MUNI_OVERRIDES:
            mn = MUNI_OVERRIDES[(cc, name)]
            out[(cc, name)] = next(mc for mc, n in cc2mc2mn[cc].mc2mn.items() if n == mn)
            continue
        for form in _muni_forms(name):
            hits = [(forms.index(form), mc) for mc, forms in by_cc[cc].items() if form in forms]
            if not hits:
                continue
            best = min(i for i, _ in hits)
            top = [mc for i, mc in hits if i == best]
            if len(top) == 1:
                out[(cc, name)] = top[0]
            break
    return out


def point_mc(geom: pd.DataFrame, cc2mc2mn: CC2MC2MN) -> np.ndarray:
    """Each `geom` point's NJDOT muni code (from its NG911 `cc` / `muni`), -1 where unknown."""
    cc = geom['cc'].astype('Int64').fillna(-1).to_numpy()
    muni = geom['muni'].astype('string').fillna('').to_numpy()
    pairs = pd.DataFrame({'cc': cc, 'muni': muni}).drop_duplicates()
    codes = muni_codes([(int(c), m) for c, m in pairs.itertuples(index=False) if c >= 0 and m], cc2mc2mn)
    key = pd.Series([f'{c}|{m}' for c, m in zip(cc, muni)])
    lut = {f'{c}|{m}': mc for (c, m), mc in codes.items()}
    return key.map(lut).fillna(-1).astype('int32').to_numpy()


def entity_slugs(
    ents: pd.DataFrame,
    runs: pd.DataFrame,
    geom: pd.DataFrame,
    pt_mc: np.ndarray,
    cc2mc2mn: CC2MC2MN,
) -> pd.DataFrame:
    """One row per entity (`ents`: `entity, name, cc`): `slug` and `mc` (the muni it's within, else
    null). Base slug `<county>/<muni>/<name>` when one muni covers ≥ `SLUG_MUNI_FRAC` of the entity's
    muni-coded points (`pt_mc` ≥ 0) and no other does, else `<county>/<name>`; county / muni
    segments are the site's (`site_slug` of `cc2mc2mn` names), the name part `slugify(name)`.
    Entities sharing a base slug are ordered by their first run's `(sri, mp_lo)` (a property of the
    road, not of entity numbering); the first keeps the base, the rest get the lowest free
    `-2`, `-3`, …."""
    e = ents[['entity', 'name', 'cc']].copy()
    pts = pd.DataFrame({'entity': geom['entity'].to_numpy(), 'mc': pt_mc})
    pts = pts[pts['mc'] >= 0]
    share = pts.groupby(['entity', 'mc']).size().rename('n').reset_index()
    share['frac'] = share['n'] / share.groupby('entity')['n'].transform('sum')
    major = share[share['frac'] >= SLUG_MUNI_FRAC]
    mc = major[major.groupby('entity')['mc'].transform('size') == 1].set_index('entity')['mc']
    e['mc'] = e['entity'].map(mc).astype('Int16')

    def county_seg(cc):
        return site_slug(cc2mc2mn[int(cc)].cn) if not pd.isna(cc) and int(cc) in cc2mc2mn else NO_COUNTY_SLUG

    def muni_seg(cc, m):
        return site_slug(cc2mc2mn[int(cc)].mc2mn[int(m)])

    # `mc` only counts when it's a muni of the entity's county.
    ok = [not pd.isna(m) and not pd.isna(c) and int(c) in cc2mc2mn and int(m) in cc2mc2mn[int(c)].mc2mn for c, m in zip(e['cc'], e['mc'])]
    e['mc'] = e['mc'].where(ok)
    e['base'] = [
        f'{county_seg(c)}/{muni_seg(c, m)}/{slugify(n)}' if not pd.isna(m) else f'{county_seg(c)}/{slugify(n)}'
        for n, c, m in zip(e['name'], e['cc'], e['mc'])
    ]
    first = runs.sort_values(['sri', 'mp_lo'], kind='stable').drop_duplicates('entity').set_index('entity')
    e['sri0'] = e['entity'].map(first['sri'])
    e['mp0'] = e['entity'].map(first['mp_lo'])
    e = e.sort_values(['base', 'sri0', 'mp0', 'entity'], kind='stable')
    e['k'] = e.groupby('base').cumcount()
    taken = set(e['base'])
    slugs = []
    for base, k in zip(e['base'], e['k']):
        if k == 0:
            slugs.append(base)
            continue
        i = k + 1
        while f'{base}-{i}' in taken:
            i += 1
        taken.add(f'{base}-{i}')
        slugs.append(f'{base}-{i}')
    e['slug'] = slugs
    return e.sort_values('entity')[['entity', 'slug', 'mc']].reset_index(drop=True)


def slug_order(slugs: pd.DataFrame) -> dict[int, int]:
    """Old entity id → new id: rank in `slug` order."""
    s = slugs.sort_values('slug', kind='stable')
    return dict(zip(s['entity'].to_numpy().tolist(), range(len(s))))


# --- Lengths -----------------------------------------------------------------------------------


def _union_len(df: pd.DataFrame, keys: list[str]) -> pd.Series:
    """Total length of the union of `[lo, hi]` intervals per `keys` group."""
    d = df.sort_values(keys + ['lo', 'hi'], kind='stable')
    prev = d.groupby(keys)['hi'].cummax().groupby([d[k] for k in keys]).shift()
    lo = np.fmax(d['lo'].to_numpy(), prev.fillna(-np.inf).to_numpy())
    d = d.assign(len=np.clip(d['hi'].to_numpy() - lo, 0, None))
    return d.groupby(keys)['len'].sum()


def entity_lengths(geom: pd.DataFrame, pt_mc: np.ndarray, parent: dict[str, str], max_gap: float, max_jump_m: float) -> dict[str, pd.Series]:
    """Road miles per entity (`total`), per `(entity, cc)` (`county`), per `(entity, cc, mc)`
    (`muni`): consecutive MP points on an SRI (≤ `max_gap` mi and ≤ `max_jump_m` apart) make a
    segment of the first point's entity / county / muni; a secondary / express SRI measures on its
    parent's MPs, so the two carriageways of a divided road overlap and count once (interval union
    per parent route)."""
    g = geom
    same = g['sri'].to_numpy()[1:] == g['sri'].to_numpy()[:-1]
    dmp = np.diff(g['mp'].to_numpy())
    dx = np.diff(g['lon'].to_numpy()) * m_per_deg_lon(g['lat'].to_numpy()[:-1])
    dy = np.diff(g['lat'].to_numpy()) * M_PER_DEG_LAT
    ok = same & (dmp <= max_gap + 1e-9) & (np.hypot(dx, dy) <= max_jump_m)
    i = np.flatnonzero(ok)
    sri = g['sri'].to_numpy()[i]
    seg = pd.DataFrame({
        'entity': g['entity'].to_numpy()[i],
        'cc': g['cc'].astype('Int64').fillna(-1).to_numpy()[i] if 'cc' in g else -1,
        'mc': pt_mc[i],
        'key': [parent.get(s, s) for s in sri],
        'lo': g['mp'].to_numpy()[i],
        'hi': g['mp'].to_numpy()[i + 1],
    })
    return {
        'total': _union_len(seg, ['entity', 'key']).groupby(level='entity').sum(),
        'county': _union_len(seg, ['entity', 'cc', 'key']).groupby(level=['entity', 'cc']).sum(),
        'muni': _union_len(seg, ['entity', 'cc', 'mc', 'key']).groupby(level=['entity', 'cc', 'mc']).sum(),
    }


# --- Summaries ---------------------------------------------------------------------------------

# `loc_source`s (`njdot.loc_recovery`) of crashes assigned to an entity without a map point (no MP).
UNPLACED_SOURCES = ('sri_only', 'name_only')


def unplaced(by_entity: pd.DataFrame) -> pd.Series:
    """Whether each crash is on its entity without a map point (`UNPLACED_SOURCES`; all false
    without a `loc_source` column)."""
    if 'loc_source' not in by_entity:
        return pd.Series(False, index=by_entity.index)
    return by_entity['loc_source'].isin(UNPLACED_SOURCES).fillna(False).astype(bool)


def road_summary(by_entity: pd.DataFrame, monthly: bool = False, xs: pd.DataFrame | None = None, key: str = 'entity') -> pd.DataFrame:
    """Crash counts per `(entity, year, severity)` (or `(entity, year, month, severity)`): `n`
    crashes (all assigned ones, placed or not), `tk` killed, `ti` injured, `n_unplaced` of them
    without a map point (`unplaced`); with `xs` (`road_model.xs_rows`: other roads' crashes at this
    road's intersections), also `n_node` (of `n`, at an intersection node, when `by_entity` has
    `node`) and `n_xs` / `tk_xs` / `ti_xs` (the `xs` crashes: the road's *inclusive* count is `n +
    n_xs`), and with `by_entity.corridor_only`, `n_corridor_only` (of `n`, crashes located to the
    road's corridor but not to this side of it). A cell appears when `n` or `n_xs` is non-zero.
    Sorted by the keys. `key`: the road column (`corridor` for corridor summaries)."""
    keys = [key, 'year', 'month', 'severity'] if monthly else [key, 'year', 'severity']

    def agg(df: pd.DataFrame, sfx: str = '') -> pd.DataFrame:
        c = df[[key, 'year', 'severity', 'tk', 'ti']].copy()
        if monthly:
            c['month'] = pd.to_datetime(df['dt']).dt.month
        c['n'] = 1
        vals = ['n', 'tk', 'ti']
        if not sfx:
            c['n_unplaced'] = unplaced(df).astype('int32').to_numpy()
            vals.append('n_unplaced')
            if xs is not None and 'node' in df:
                c['n_node'] = df['node'].notna().astype('int32').to_numpy()
                vals.append('n_node')
        out = c.groupby(keys, as_index=False, observed=True)[vals].sum()
        return out.rename(columns={v: f'{v}{sfx}' for v in vals})

    out = agg(by_entity)
    vals = [c for c in out.columns if c not in keys]
    if xs is not None:
        x = agg(xs, '_xs')
        out = out.merge(x, on=keys, how='outer')
        vals += ['n_xs', 'tk_xs', 'ti_xs']
    if 'corridor_only' in by_entity:
        # v5.1: of `n`, crashes located to the road's corridor, not to this side of it.
        co = agg(by_entity[by_entity['corridor_only'].fillna(False).to_numpy(dtype=bool)])[keys + ['n']].rename(columns={'n': 'n_corridor_only'})
        out = out.merge(co, on=keys, how='left')
        vals.append('n_corridor_only')
    for v in vals:
        out[v] = out[v].fillna(0)
    out = out.astype({key: 'int32', 'year': 'int16', 'severity': 'string'} | {v: 'int32' for v in vals})
    if monthly:
        out['month'] = out['month'].astype('int8')
    return out.sort_values(keys, kind='stable').reset_index(drop=True)[keys + vals]


# --- Ranks -------------------------------------------------------------------------------------

RANK_TOP = 50
# Crashes per mile is ranked only for roads with ≥ this many miles / crashes in the area (a 0.05-mi
# stub with 3 crashes isn't the "most dangerous road").
PER_MI_MIN_MI = 0.25
PER_MI_MIN_N = 10
RANK_METRICS = {'crashes': 'n_crashes', 'fatal': 'n_fatal', 'killed': 'n_killed', 'per_mi': 'per_mi'}


def road_ranks(by_entity: pd.DataFrame, ents: pd.DataFrame, lengths: dict[str, pd.Series], top: int = RANK_TOP) -> pd.DataFrame:
    """Each county's (`mc` = 0) and muni's top roads: one row per `(cc, mc, entity)` in the area's
    top `top` by any of `RANK_METRICS`, with the road's crashes / fatal crashes / killed *in the
    area* (by the crash's own `cc` / `mc`), its miles in the area (`length_mi`), `per_mi`, and a
    rank per metric (1 = worst; null when outside the top `top`, zero, or — for `per_mi` — below
    `PER_MI_MIN_MI` / `PER_MI_MIN_N`). Ramps (`subt` 8) aren't ranked. Sorted `(cc, mc, rank_crashes)`."""
    c = by_entity[['entity', 'cc', 'mc', 'severity', 'tk']]
    c = c[c['cc'].between(1, 21) & c['mc'].notna() & (c['mc'] > 0)].assign(
        f=lambda d: d['severity'].eq('f').astype('int32'), tk=lambda d: d['tk'].fillna(0).astype('int32'),
    )
    agg = dict(n_crashes=('f', 'size'), n_fatal=('f', 'sum'), n_killed=('tk', 'sum'))
    muni = c.groupby(['cc', 'mc', 'entity'], as_index=False).agg(**agg)
    county = c.groupby(['cc', 'entity'], as_index=False).agg(**agg).assign(mc=0)
    df = pd.concat([county, muni], ignore_index=True)
    ln_c = lengths['county'].rename('length_mi').reset_index()
    ln_m = lengths['muni'].rename('length_mi').reset_index()
    ln = pd.concat([ln_c.assign(mc=0), ln_m[ln_m['mc'] > 0]], ignore_index=True)
    df = df.merge(ln[['entity', 'cc', 'mc', 'length_mi']], on=['entity', 'cc', 'mc'], how='left')
    df['length_mi'] = df['length_mi'].fillna(0.0)
    df = df.merge(ents[['entity', 'slug', 'name', 'route', 'subt']], on='entity')
    df = df[df['subt'] < 8]
    eligible = (df['length_mi'] >= PER_MI_MIN_MI) & (df['n_crashes'] >= PER_MI_MIN_N)
    df['per_mi'] = (df['n_crashes'] / df['length_mi'].where(eligible)).astype('float32')
    keep = np.zeros(len(df), dtype=bool)
    for m, col in RANK_METRICS.items():
        v = df[col].where(df[col] > 0)
        r = (
            df.assign(v=v).sort_values(['cc', 'mc', 'v', 'slug'], ascending=[True, True, False, True], na_position='last')
            .groupby(['cc', 'mc']).cumcount() + 1
        ).reindex(df.index)
        r = r.where(v.notna() & (r <= top))
        df[f'rank_{m}'] = r.astype('Int16')
        keep |= r.notna().to_numpy()
    df = df[keep]
    df = df.astype({'cc': 'int8', 'mc': 'int16', 'entity': 'int32', 'subt': 'int8', 'n_crashes': 'int32', 'n_fatal': 'int32', 'n_killed': 'int32', 'length_mi': 'float32'})
    cols = ['cc', 'mc', 'entity', 'slug', 'name', 'route', 'subt', 'n_crashes', 'n_fatal', 'n_killed', 'length_mi', 'per_mi'] + [f'rank_{m}' for m in RANK_METRICS]
    return df.sort_values(['cc', 'mc', 'rank_crashes', 'slug'], na_position='last', kind='stable').reset_index(drop=True)[cols]


# --- Search ------------------------------------------------------------------------------------

# Canonical (long) word → its abbreviations. Index tokens are canonical; the frontend maps each
# query word the same way (`www/src/map/roads/roadSearch.ts` `SYNONYMS` must list these groups).
# "st" is "saint" as the first of several words ("St Pauls Ave"), else "street".
SYNONYMS = {
    'north': ['n'], 'south': ['s'], 'east': ['e'], 'west': ['w'],
    'avenue': ['ave', 'av'], 'street': ['st'], 'saint': ['st'], 'boulevard': ['blvd'], 'road': ['rd'],
    'drive': ['dr'], 'highway': ['hwy'], 'parkway': ['pkwy'], 'turnpike': ['tpke', 'tpk'],
    'place': ['pl'], 'lane': ['ln'], 'court': ['ct'], 'terrace': ['ter'], 'expressway': ['expy'],
    'route': ['rt', 'rte'], 'county': ['co'], 'mount': ['mt'], 'fort': ['ft'], 'circle': ['cir'],
}
CANON = {a: w for w, abbrs in SYNONYMS.items() for a in abbrs if a != 'st'}
# Rows per token are capped (most crashes first): only street-type / direction / route words
# ("avenue", "road", "county", "west", …) have more, and a query should narrow by a rarer word.
TOKEN_CAP = 1000
# bbox offsets from `lon` / `lat`, in units of this many degrees.
BBOX_UNIT = 1e-5


def words(s: str) -> list[str]:
    """Lower-case ASCII words, split on non-alphanumerics (as the frontend's `queryTokens`)."""
    a = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii').lower()
    return [w for w in re.split(r'[^a-z0-9]+', a) if w]


def canon_words(s: str) -> list[str]:
    """`words`, each mapped to its canonical form (`SYNONYMS`)."""
    ws = words(s)
    return [('saint' if i == 0 and len(ws) > 1 else 'street') if w == 'st' else CANON.get(w, w) for i, w in enumerate(ws)]


def place_label(cc, munis, cc2mc2mn: CC2MC2MN) -> str | None:
    """"Jersey City, Hudson" / "North Bergen Township · Jersey City, Hudson" / "Hudson County"
    (3+ munis) / the munis alone (no county)."""
    county = cc2mc2mn[int(cc)].cn if not pd.isna(cc) and int(cc) in cc2mc2mn else None
    ms = [] if munis is None or pd.isna(munis) else str(munis).split(' · ')
    if county is None:
        return ' · '.join(ms) or None
    if not ms or len(ms) > 2:
        return f'{county} County'
    return f"{' · '.join(ms)}, {county}"


SEARCH_COLS = [
    'token', 'entity', 'slug', 'name', 'matched', 'kind', 'words', 'subt', 'n_crashes', 'cc', 'place',
    'lon', 'lat', 'dx0', 'dy0', 'dx1', 'dy1',
]


def road_search_index(names_idx: pd.DataFrame, ents: pd.DataFrame, cc2mc2mn: CC2MC2MN, cap: int = TOKEN_CAP) -> tuple[pd.DataFrame, dict[str, int]]:
    """⌘K word index over `names_idx` (`roads.road_names_index`: one row per searchable name of an
    entity, with its span point / bbox): one row per `(token, name row)` for each distinct canonical
    word of the name (`canon_words`); `matched` = the name (null when it's the entity's own `name`),
    `words` = all its canonical words, space-joined (for filtering on the other query words), `place`
    (`place_label`), bbox as int32 offsets from `lon` / `lat` in `BBOX_UNIT`°. Each token keeps its
    `cap` rows with the most crashes. Sorted `(token, n_crashes desc, entity, matched)`. Also returns
    the capped tokens' full row counts."""
    e = ents.set_index('entity')
    n = names_idx.reset_index(drop=True)
    ename = e.loc[n['entity'], 'name'].to_numpy()
    rows = n.drop(columns=['cc'], errors='ignore').assign(
        name=ename,
        cc=e.loc[n['entity'], 'cc'].to_numpy(),
        slug=e.loc[n['entity'], 'slug'].to_numpy(),
        matched=n['name_display'].where(n['name_display'].to_numpy() != ename),
        cw=[canon_words(s) for s in n['name_display']],
    )
    rows['words'] = rows['cw'].map(' '.join)
    rows['token'] = rows['cw'].map(lambda ws: sorted(set(ws)))
    rows = rows[rows['token'].map(len) > 0].explode('token')
    places = {ent: place_label(cc, m, cc2mc2mn) for ent, cc, m in zip(e.index, e['cc'], e['munis'])}
    rows['place'] = rows['entity'].map(places)
    for c, (a, b) in {'dx0': ('lon_min', 'lon'), 'dy0': ('lat_min', 'lat'), 'dx1': ('lon_max', 'lon'), 'dy1': ('lat_max', 'lat')}.items():
        rows[c] = np.round((rows[a].astype('float64') - rows[b].astype('float64')) / BBOX_UNIT).astype('int32')
    rows = rows.sort_values(['token', 'n_crashes', 'entity', 'matched'], ascending=[True, False, True, True], na_position='first', kind='stable')
    counts = rows.groupby('token').size()
    capped = {t: int(k) for t, k in counts[counts > cap].items()}
    rows = rows.groupby('token', sort=False).head(cap)
    out = rows[SEARCH_COLS].astype({
        'token': 'string', 'entity': 'int32', 'slug': 'string', 'name': 'string', 'matched': 'string', 'kind': 'string',
        'words': 'string', 'subt': 'int8', 'n_crashes': 'int32', 'cc': 'Int8', 'place': 'string',
        'lon': 'float32', 'lat': 'float32',
    })
    return out.reset_index(drop=True), capped


def search_meta(capped: dict[str, int]) -> dict[str, str]:
    """`road-search.parquet` key-value metadata: the synonym table, and the capped tokens."""
    return {
        'synonyms': json.dumps(SYNONYMS, separators=(',', ':')),
        'token_cap': str(TOKEN_CAP),
        'capped_tokens': json.dumps(capped, separators=(',', ':'), sort_keys=True),
        'bbox_unit': str(BBOX_UNIT),
    }
