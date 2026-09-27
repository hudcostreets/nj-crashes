"""Road network model for `njdot roads build` (specs/road-data-v3.md).

- **Lines → MP points** (`rn_features`, `rn_points`): each NJDOT Roadway Network feature is a polyline
  with a milepost (M) on every vertex. Points are laid every `STEP` miles *in the MP convention crashes
  use*: a secondary / express SRI (`00000001_S`, `00000444ES`, …) is measured on its *parent* route's
  MPs (`PARENT_MP_START` → `PARENT_MP_END`, linear in the local measure), everything else on its own.
- **NG911 segments → SRI intervals** (`ng_intervals`): a segment's `SRI` tag is accepted when its start,
  midpoint and end all lie within `TAG_TOL_M` of that SRI's line; untagged / mis-tagged segments snap to
  a line only when they lie along it (all three within `SNAP_TOL_M`). Accepted segments are projected
  onto the line to `[mp_lo, mp_hi]`.
- **Names on points** (`name_points`): each MP point takes the local name, county and muni of the NG911
  interval it sits most inside; points no segment covers keep the NJDOT `SLD_NAME`.
- **Entities** (`road_entities`): runs (same SRI, name and county; contiguous MPs) join into one road
  when they lie in the same county, touch, and one's name is the other's name or NG911 local (`L`)
  alias (compared by `merge_key`). "Touch": consecutive on one SRI, or a secondary run overlapping
  its parent's (any alias counts), or a run end within `ENTITY_JOIN_M` of a point of the other run
  (only aliases covering ≥ `ALIAS_MERGE_FRAC` of the run count); or, for the *same* name in the same
  muni, run ends within `ENTITY_GAP_M` (a street interrupted by a plaza / interchange). Same-name
  runs join first; an alias join then also needs the alias to cover ≥ `ALIAS_GROUP_FRAC` of the
  aliasing run's whole same-name road, so a short junction run can't bridge two roads. So "Kennedy Boulevard" (Hudson CR 501) and "J F Kennedy
  Boulevard" are one road, while West Side Ave in Jersey City and in North Bergen are two, and Park
  Ave (Hoboken → Weehawken) isn't Boulevard East.
"""
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree

STEP = 0.05
# Grid MPs are rounded to this many decimals (and endpoint MPs kept as-is, rounded).
MP_DECIMALS = 3
TAG_TOL_M = 20
SNAP_TOL_M = 10
SNAP_MIN_LEN_M = 30
# Intervals shorter than this (miles) are dropped: a segment that projects to a point is a cross street.
MIN_INTERVAL_MI = 0.005
# A point takes a name from an interval it's within this many miles of.
NAME_EPS_MI = 0.03
ENTITY_JOIN_M = 60
# An NG911 local alias joins runs only if it covers at least this share of its run's points: a single
# junction segment of Duncan Ave carries the alias "Bergen Avenue", which mustn't merge the two.
ALIAS_MERGE_FRAC = 0.5
# …and it must cover this share of the run's whole same-named road (its same-name component): a
# 2-point "Park Avenue" junction run aliased "Boulevard East" mustn't fuse the two roads.
ALIAS_GROUP_FRAC = 0.5
# Same-named runs in the same muni whose ends are this close join across a gap (West Side Ave, Jersey City
# has a ~350 m break near Journal Square, in NJDOT's network and NG911 alike).
ENTITY_GAP_M = 400
M_PER_DEG_LAT = 110_540
# NJ State Plane (meters).
TO_M = Transformer.from_crs(4326, 32118, always_xy=True)

SHIELD_PREFIX = {
    'INT': 'I-', 'USR': 'US ', 'STR': 'NJ ', 'COR': 'CR ',
}
SHIELD_NAMES = {
    'TPK': 'NJ Turnpike', 'GSP': 'Garden State Pkwy', 'ACE': 'Atlantic City Expy', 'PIP': 'Palisades Pkwy',
    'ACB': 'AC-Brigantine Connector',
}
SHIELD_SUFFIX = {'A': ' Alt', 'B': ' Bus', 'Y': ' Byp', 'C': ' Conn', 'E': ' Express', 'S': ' Spur', 'T': ' Truck'}


def shield(tpe: str | None, sub: str | None, num: str | None) -> str | None:
    """NG911 shield fields → a route designation: ("COR", "M", "501") → "CR 501", ("USR", "T", "1")
    → "US 1 Truck", ("TPK", …) → "NJ Turnpike"; `None` for no shield ("N")."""
    if tpe in SHIELD_NAMES:
        return SHIELD_NAMES[tpe]
    if tpe not in SHIELD_PREFIX or not num:
        return None
    return f'{SHIELD_PREFIX[tpe]}{num.strip()}{SHIELD_SUFFIX.get(sub or "", "")}'


# Street-type / direction words → the SLD's abbreviations, so "WEST SIDE AVENUE" == "W Side Ave".
ABBREVS = {
    'AVENUE': 'AVE', 'AV': 'AVE', 'STREET': 'ST', 'ROAD': 'RD', 'BOULEVARD': 'BLVD', 'DRIVE': 'DR',
    'PLACE': 'PL', 'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'TURNPIKE': 'TPKE', 'LANE': 'LN', 'COURT': 'CT',
    'TERRACE': 'TER', 'EXPRESSWAY': 'EXPY', 'ROUTE': 'RT', 'WEST': 'W', 'EAST': 'E', 'NORTH': 'N', 'SOUTH': 'S',
    'SAINT': 'ST', 'MOUNT': 'MT', 'FORT': 'FT',
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
    # Diacritics dropped ("Muñoz" == "MUNOZ").
    s = s.astype('string').str.normalize('NFKD').str.encode('ascii', 'ignore').str.decode('ascii').astype('string')
    s = s.str.upper().str.replace('.', '', regex=False).str.replace(r'\s+', ' ', regex=True).str.strip()
    return s.str.replace(ABBREV_RE, lambda m: ABBREVS[m.group(1)], regex=True)


def m_per_deg_lon(lat):
    return 111_320 * np.cos(np.radians(lat))


def to_meters(x, y) -> tuple[np.ndarray, np.ndarray]:
    return TO_M.transform(np.asarray(x, dtype=float), np.asarray(y, dtype=float))


def ragged_to_meters(xs, ys) -> tuple[list[np.ndarray], list[np.ndarray], np.ndarray]:
    """Per-feature lon / lat vertex lists → per-feature meter arrays (one `pyproj` call for all),
    plus the vertex counts."""
    lens = np.array([len(x) for x in xs], dtype=np.int64)
    X, Y = to_meters(np.concatenate([np.asarray(x, dtype=float) for x in xs]) if len(xs) else [], np.concatenate([np.asarray(y, dtype=float) for y in ys]) if len(ys) else [])
    cuts = np.cumsum(lens)[:-1]
    return np.split(X, cuts), np.split(Y, cuts), lens


def lines_from(Xs: list[np.ndarray], Ys: list[np.ndarray], lens: np.ndarray) -> np.ndarray:
    """Per-feature meter arrays (each ≥ 2 vertices) → an array of shapely LineStrings."""
    if not len(lens):
        return np.array([], dtype=object)
    coords = np.c_[np.concatenate(Xs), np.concatenate(Ys)]
    return shapely.linestrings(coords, indices=np.repeat(np.arange(len(lens)), lens))


def rn_features(rn: pd.DataFrame) -> pd.DataFrame:
    """Roadway Network rows (one per feature path) → one row per feature with its MP mapping:
    `sri, subt, sld_name, parent, sec, ms, me, ps, pe, x, y, m, X, Y, d` (`X`/`Y`: meters, `d`:
    cumulative vertex distance). `sec` rows report parent MPs; `m` is the vertex measure (vertex
    distance scaled to `[ms, me]` when the source M-values are missing, non-monotonic, or don't
    span the feature's measure range)."""
    df = rn.rename(columns={
        'SRI': 'sri', 'ROUTE_SUBTYPE': 'subt', 'SLD_NAME': 'sld_name', 'PARENT_SRI': 'parent',
        'MP_START': 'ms', 'MP_END': 'me', 'PARENT_MP_START': 'ps', 'PARENT_MP_END': 'pe',
    })
    df = df[[len(x) >= 2 for x in df['x']]].reset_index(drop=True)
    for c in ('ms', 'me', 'ps', 'pe'):
        df[c] = df[c].astype(float)
    df['sec'] = df['parent'].notna() & (df['parent'] != df['sri']) & df['ps'].ne(df['pe']) & df['ps'].notna()
    Xs, Ys, _ = ragged_to_meters(df['x'], df['y'])
    ms, ds = [], []
    for X, Y, m, lo, hi in zip(Xs, Ys, df['m'], df['ms'], df['me']):
        d = np.r_[0, np.cumsum(np.hypot(np.diff(X), np.diff(Y)))]
        m = np.array([np.nan if v is None else v for v in m], dtype=float)
        if np.isnan(m).any() or (np.diff(m) < -1e-9).any() or m[0] > lo + 0.01 or m[-1] < hi - 0.01:
            m = lo + (d / d[-1] if d[-1] > 0 else d) * (hi - lo)
        ms.append(m)
        ds.append(d)
    df['m'] = ms
    df['X'] = Xs
    df['Y'] = Ys
    df['d'] = ds
    df['subt'] = df['subt'].astype('int8')
    return df[['sri', 'subt', 'sld_name', 'parent', 'sec', 'ms', 'me', 'ps', 'pe', 'x', 'y', 'm', 'X', 'Y', 'd']]


def to_mp(sec, ms, me, ps, pe, m):
    """Local measure `m` → reported MP (parent MP for secondaries); vectorized over features."""
    sec = np.asarray(sec) & (np.asarray(me) != np.asarray(ms))
    with np.errstate(divide='ignore', invalid='ignore'):
        par = ps + (np.asarray(m) - ms) / (np.asarray(me) - ms) * (np.asarray(pe) - ps)
    return np.where(sec, par, m)


def from_mp(sec, ms, me, ps, pe, mp):
    sec = np.asarray(sec) & (np.asarray(me) != np.asarray(ms))
    with np.errstate(divide='ignore', invalid='ignore'):
        loc = ms + (np.asarray(mp) - ps) / (np.asarray(pe) - ps) * (np.asarray(me) - ms)
    return np.where(sec, loc, mp)


def rn_points(feats: pd.DataFrame, step: float = STEP) -> pd.DataFrame:
    """MP points along every feature: multiples of `step` within its reported MP range, plus its
    ends. `(sri, mp, sld_name, subt, lon, lat)`, sorted `(sri, mp)`, one row per `(sri, mp)`."""
    fid, mps, lons, lats = [], [], [], []
    for i, f in enumerate(feats.itertuples()):
        a, b = sorted((float(to_mp(f.sec, f.ms, f.me, f.ps, f.pe, f.ms)), float(to_mp(f.sec, f.ms, f.me, f.ps, f.pe, f.me))))
        grid = np.arange(np.ceil(a / step - 1e-9), np.floor(b / step + 1e-9) + 1) * step
        mp = np.unique(np.round(np.r_[a, grid, b], MP_DECIMALS) + 0.0)  # `+ 0.0`: no `-0.0`
        m = from_mp(f.sec, f.ms, f.me, f.ps, f.pe, mp)
        order = np.argsort(f.m, kind='stable')
        lons.append(np.interp(m, f.m[order], np.asarray(f.x)[order]))
        lats.append(np.interp(m, f.m[order], np.asarray(f.y)[order]))
        mps.append(mp)
        fid.append(np.full(len(mp), i))
    fid = np.concatenate(fid)
    df = pd.DataFrame({
        'sri': feats['sri'].to_numpy()[fid], 'mp': np.concatenate(mps), 'sld_name': feats['sld_name'].to_numpy()[fid],
        'subt': feats['subt'].to_numpy()[fid].astype('int8'), 'lon': np.concatenate(lons), 'lat': np.concatenate(lats),
    })
    return df.sort_values(['sri', 'mp'], kind='stable').drop_duplicates(['sri', 'mp']).reset_index(drop=True)


# NG9-1-1 placeholder names ("Unnamed Segment": 26k segments statewide), which aren't names: a
# point there keeps NJDOT's SLD name, and unrelated unnamed streets don't join into one entity.
PLACEHOLDER_NAME_RE = r'(?i)^(unnamed\b.*|ramp|driveway)$'


def ng_name(s: pd.Series) -> pd.Series:
    """NG911 `PRIMENAME`s, stripped; blank or placeholder (`PLACEHOLDER_NAME_RE`) → NA."""
    n = s.astype('string').str.strip().replace('', pd.NA)
    return n.mask(n.str.match(PLACEHOLDER_NAME_RE).fillna(False))


def ng_segments(cl: pd.DataFrame) -> pd.DataFrame:
    """NG911 centerline rows → `seg` frame: names (`ng_name`), place, shield, and metric geometry
    (`line`, and `start` / `mid` / `end` points)."""
    df = cl[[len(x) >= 2 for x in cl['x']]].reset_index(drop=True)
    line = lines_from(*ragged_to_meters(df['x'], df['y']))
    return pd.DataFrame({
        'rcl': df['RCL_NGUID'].astype('string'),
        'tag': df['SRI'].astype('string').str.strip().replace('', pd.NA),
        'name': ng_name(df['PRIMENAME']),
        'cc': df['cc_l'].fillna(df['cc_r']).astype('Int8'),
        'muni': df['muni_l'].fillna(df['muni_r']).astype('string'),
        'shield': [shield(t, s, n) for t, s, n in zip(df['SHLD_TYPE'], df['SHLDSUBTYP'], df['SHLD_NUM'])],
        'line': line,
        'start': shapely.get_point(line, 0),
        'mid': shapely.line_interpolate_point(line, 0.5, normalized=True),
        'end': shapely.get_point(line, -1),
        'len_m': shapely.length(line),
    })


def _locate(feats: pd.DataFrame, fid: np.ndarray, pts: np.ndarray, lines: np.ndarray) -> np.ndarray:
    """Reported MP of each point `pts[i]` projected onto feature `fid[i]`."""
    t = shapely.line_locate_point(lines[fid], pts)
    m = np.empty(len(fid))
    order = np.argsort(fid, kind='stable')
    fs, starts = np.unique(fid[order], return_index=True)
    ends = np.r_[starts[1:], len(order)]
    d_col, m_col = feats['d'].to_numpy(), feats['m'].to_numpy()
    for f, a, b in zip(fs, starts, ends):
        idx = order[a:b]
        m[idx] = np.interp(t[idx], d_col[f], m_col[f])
    return to_mp(
        feats['sec'].to_numpy()[fid], feats['ms'].to_numpy()[fid], feats['me'].to_numpy()[fid],
        feats['ps'].to_numpy()[fid], feats['pe'].to_numpy()[fid], m,
    )


def ng_intervals(seg: pd.DataFrame, feats: pd.DataFrame) -> pd.DataFrame:
    """Each NG911 segment accepted onto an SRI line (see module docstring) → `(seg, sri, fid, mp_lo,
    mp_hi, src)` with `src` "tag" (its own SRI tag checked) or "snap" (geometric match)."""
    lines = lines_from(list(feats['X']), list(feats['Y']), np.array([len(x) for x in feats['X']]))
    fsri = feats['sri'].to_numpy()

    def dists(s_idx, f_idx):
        return np.c_[
            shapely.distance(lines[f_idx], seg['start'].to_numpy()[s_idx]),
            shapely.distance(lines[f_idx], seg['mid'].to_numpy()[s_idx]),
            shapely.distance(lines[f_idx], seg['end'].to_numpy()[s_idx]),
        ]

    # Tagged: pairs (segment, feature of its tagged SRI).
    f_by_sri = pd.DataFrame({'sri': fsri, 'fid': np.arange(len(feats))})
    tagged = seg[['tag']].reset_index(names='s').dropna().merge(f_by_sri, left_on='tag', right_on='sri')
    s_idx, f_idx = tagged['s'].to_numpy(), tagged['fid'].to_numpy()
    d = dists(s_idx, f_idx) if len(tagged) else np.empty((0, 3))
    tagged = tagged.assign(d0=d[:, 0], d1=d[:, 1], d2=d[:, 2])
    # A tag holds if the segment's midpoint is within tolerance of some piece of the SRI, and each
    # end is within tolerance of some piece (possibly another, across a piece boundary).
    g = tagged.groupby('s')
    tag_ok = (g['d0'].min() <= TAG_TOL_M) & (g['d1'].min() <= TAG_TOL_M) & (g['d2'].min() <= TAG_TOL_M)
    tag_ok = tag_ok[tag_ok].index
    t = tagged[tagged['s'].isin(tag_ok)]
    f0 = t.loc[t.groupby('s')['d0'].idxmin(), ['s', 'fid', 'sri']].set_index('s')
    f2 = t.loc[t.groupby('s')['d2'].idxmin(), ['s', 'fid']].set_index('s')
    tag_iv = pd.DataFrame({'seg': f0.index.to_numpy(), 'sri': f0['sri'].to_numpy(), 'fid': f0['fid'].to_numpy(), 'fid2': f2.loc[f0.index, 'fid'].to_numpy(), 'src': 'tag'})

    # Snap: segments without an accepted tag, lying along some line.
    rest = np.setdiff1d(np.arange(len(seg)), tag_ok.to_numpy())
    rest = rest[seg['len_m'].to_numpy()[rest] >= SNAP_MIN_LEN_M]
    tree = shapely.STRtree(lines)
    pairs = tree.query(seg['mid'].to_numpy()[rest], predicate='dwithin', distance=SNAP_TOL_M)
    snap_iv = pd.DataFrame(columns=['seg', 'sri', 'fid', 'fid2', 'src'])
    if pairs.shape[1]:
        s_idx, f_idx = rest[pairs[0]], pairs[1]
        d = dists(s_idx, f_idx)
        sp = pd.DataFrame({'s': s_idx, 'fid': f_idx, 'dsum': d.sum(axis=1), 'ok': (d <= SNAP_TOL_M).all(axis=1)})
        sp = sp[sp['ok']].sort_values(['s', 'dsum', 'fid'], kind='stable').drop_duplicates('s')
        snap_iv = pd.DataFrame({'seg': sp['s'].to_numpy(), 'sri': fsri[sp['fid'].to_numpy()], 'fid': sp['fid'].to_numpy(), 'fid2': sp['fid'].to_numpy(), 'src': 'snap'})

    iv = pd.concat([tag_iv, snap_iv], ignore_index=True)
    s = iv['seg'].to_numpy(dtype=int)
    mp0 = _locate(feats, iv['fid'].to_numpy(dtype=int), seg['start'].to_numpy()[s], lines)
    mp1 = _locate(feats, iv['fid2'].to_numpy(dtype=int), seg['end'].to_numpy()[s], lines)
    iv['mp_lo'] = np.round(np.minimum(mp0, mp1), 4)
    iv['mp_hi'] = np.round(np.maximum(mp0, mp1), 4)
    iv = iv[iv['mp_hi'] - iv['mp_lo'] >= MIN_INTERVAL_MI]
    iv = iv.astype({'seg': int, 'fid': int}).drop(columns='fid2')
    return iv.sort_values(['sri', 'mp_lo', 'mp_hi', 'seg'], kind='stable').reset_index(drop=True)


def name_points(geom: pd.DataFrame, iv: pd.DataFrame, seg: pd.DataFrame, con) -> pd.DataFrame:
    """Add `name`, `cc`, `muni`, `seg` to MP points: from the *named* interval on the point's SRI
    that it sits most inside (within `NAME_EPS_MI`; ties → the longer interval, then lower `seg`).
    Uncovered points: `name` = `sld_name`, `seg` = -1, `cc` from a covered neighbor on the SRI, else
    the SRI's county prefix (`09…` → 9), `muni` from a neighbor."""
    ivn = iv.assign(name=seg['name'].to_numpy()[iv['seg']])
    ivn = ivn[ivn['name'].notna()]
    con.register('p', geom[['sri', 'mp']].reset_index(names='i'))
    con.register('iv', ivn[['sri', 'mp_lo', 'mp_hi', 'seg']])
    best = con.sql(f"""
        SELECT i, arg_max(seg, (least(p.mp - mp_lo, mp_hi - p.mp), mp_hi - mp_lo, -seg)) AS seg
        FROM p JOIN iv ON p.sri = iv.sri AND p.mp BETWEEN mp_lo - {NAME_EPS_MI} AND mp_hi + {NAME_EPS_MI}
        GROUP BY i
    """).df()
    con.unregister('p'); con.unregister('iv')
    out = geom.copy()
    s = pd.Series(-1, index=out.index, dtype='int64')
    s.loc[best['i'].to_numpy()] = best['seg'].to_numpy()
    out['seg'] = s.to_numpy()
    has = out['seg'] >= 0
    si = out.loc[has, 'seg'].to_numpy()
    out['name'] = out['sld_name'].astype('string')
    out.loc[has, 'name'] = seg['name'].to_numpy()[si]
    cc = pd.Series(pd.NA, index=out.index, dtype='Int8')
    cc[has] = seg['cc'].to_numpy()[si]
    muni = pd.Series(pd.NA, index=out.index, dtype='string')
    muni[has] = seg['muni'].to_numpy()[si]
    g = out['sri']
    cc = cc.groupby(g).ffill().groupby(g).bfill()
    prefix = pd.to_numeric(out['sri'].str[:2], errors='coerce')
    cc = cc.fillna(prefix.where(prefix.between(1, 21)).astype('Int8')).astype('Int8')
    out['cc'] = cc
    out['muni'] = muni.groupby(g).ffill().groupby(g).bfill()
    return out


def merge_key(s: pd.Series) -> pd.Series:
    """`name_key` with doubled letters squeezed, "John F" → "J F" and "Jr" dropped, so spelling
    variants ("Tonnele" / "Tonnelle", "JOHN F KENNEDY BLVD E" / "J F Kennedy Boulevard East",
    "MARTIN LUTHER KING JR DR" / "Martin Luther King Drive") match."""
    u = s.astype('string').str.upper().str.replace(r'\bJOHN F\.?\s', 'J F ', regex=True)
    k = name_key(u.str.replace(r'\bJR\b\.?', ' ', regex=True))
    return k.str.replace(r'(.)\1+', r'\1', regex=True)


def dir_key(s: pd.Series) -> pd.Series:
    """`merge_key` of the name without a trailing, then a leading, direction word, each dropped only
    when ≥ 2 words remain: "West 48th Street" / "East 48th Street" → "48THST", "North Avenue East"
    → "NORTHAVE" (not "AVE"), "North Avenue" → "NORTHAVE". Two names with one `dir_key` but different
    `merge_key`s are *direction variants*: one right-of-way (a corridor), not one entity."""
    def strip(n):
        if n is None or pd.isna(n):
            return n
        w = n.split()
        if len(w) > 2 and w[-1] in DIRECTIONS:
            w = w[:-1]
        if len(w) > 2 and w[0] in DIRECTIONS:
            w = w[1:]
        return ' '.join(w)
    n = norm_name(s)
    return merge_key(pd.Series([strip(v) for v in n.to_numpy(dtype=object)], index=s.index, dtype='string'))


def seg_aliases(al: pd.DataFrame) -> pd.DataFrame:
    """Alias rows → `(rcl, kind, alias, shield)`: `kind` "L" (local name) or "H" (highway / route
    name, with its `shield` designation)."""
    return pd.DataFrame({
        'rcl': al['RCL_NGUID'].astype('string'),
        'kind': al['ANAME_TYP'].astype('string'),
        'rank': al['ANAME_RANK'],
        'alias': al['AST_PNAME'].astype('string').str.strip(),
        'shield': [shield(t, s, n) for t, s, n in zip(al['SHLD_TYPE'], al['SHLDSUBTYP'], al['SHLD_NUM'])],
    }).dropna(subset=['alias'])


def run_names(geom: pd.DataFrame, point_run: np.ndarray, seg: pd.DataFrame, aliases: pd.DataFrame) -> pd.DataFrame:
    """Per (run, name) NG911 name facts weighted by point count: rows `(run, kind, value, n)` with
    `kind` "L" (local alias), "H" (route alias's full name), "shield" (route designation, from the
    segments' own shields and their `H` aliases')."""
    pts = pd.DataFrame({'run': point_run, 'seg': geom['seg'].to_numpy()})
    pts = pts[pts['seg'] >= 0]
    n = pts.groupby(['run', 'seg']).size().rename('n').reset_index()
    n['rcl'] = seg['rcl'].to_numpy()[n['seg']]
    n['own_shield'] = np.array(seg['shield'].to_numpy(), dtype=object)[n['seg']]
    out = [n.dropna(subset=['own_shield']).assign(kind='shield', value=lambda d: d['own_shield'])[['run', 'kind', 'value', 'n']]]
    a = n.merge(aliases, on='rcl')
    out.append(a[a['kind'].isin(['L', 'H'])].assign(value=a['alias'])[['run', 'kind', 'value', 'n']])
    out.append(a[a['kind'].eq('H')].dropna(subset=['shield']).assign(kind='shield', value=lambda d: d['shield'])[['run', 'kind', 'value', 'n']])
    df = pd.concat(out, ignore_index=True)
    return df.groupby(['run', 'kind', 'value'], as_index=False)['n'].sum().sort_values(['run', 'kind', 'n', 'value'], ascending=[True, True, False, True]).reset_index(drop=True)


def road_entities(runs: pd.DataFrame, geom: pd.DataFrame, point_run: np.ndarray, names: pd.DataFrame | None = None, parent: dict[str, str] | None = None) -> pd.Series:
    """Entity id per run (see module docstring). `runs` needs `sri, name, cc, mp_lo, mp_hi, lon0,
    lat0, lon1, lat1`; `names` (from `run_names`) adds `L` aliases to each run's name set; `parent`
    maps secondary SRIs to their parent. Ids are numbered in `(sri, mp_lo)` order of each entity's
    first run (`roads build` then renumbers them in slug order)."""
    n = len(runs)
    name_k = merge_key(runs['name']).to_numpy()
    # Each run's NG911 local aliases: all of them (`every`), and those covering ≥ `ALIAS_MERGE_FRAC`
    # of its points (`major`).
    every: list[set] = [set() for _ in range(n)]
    major: list[set] = [set() for _ in range(n)]
    if names is not None and len(names):
        size = np.bincount(point_run, minlength=n)
        la = names[names['kind'] == 'L']
        big = la['n'].to_numpy() >= ALIAS_MERGE_FRAC * size[la['run'].to_numpy()]
        for r, k, b in zip(la['run'].to_numpy(), merge_key(la['value']).to_numpy(), big):
            every[r].add(k)
            if b:
                major[r].add(k)
    cc = runs['cc'].to_numpy() if 'cc' in runs else np.zeros(n)
    same_cc = lambda a, b: (pd.isna(cc[a]) and pd.isna(cc[b])) or (not pd.isna(cc[a]) and not pd.isna(cc[b]) and cc[a] == cc[b])

    # Touching run pairs `(a, b)`, `a < b`, in the same county.
    touch: set[tuple[int, int]] = set()

    def add(a, b):
        a, b = int(a), int(b)
        if a != b and same_cc(a, b):
            touch.add((min(a, b), max(a, b)))

    X, Y = to_meters(geom['lon'].to_numpy(), geom['lat'].to_numpy())
    tree = cKDTree(np.c_[X, Y])
    for lon_c, lat_c in (('lon0', 'lat0'), ('lon1', 'lat1')):
        EX, EY = to_meters(runs[lon_c].to_numpy(), runs[lat_c].to_numpy())
        for r, hits in enumerate(tree.query_ball_point(np.c_[EX, EY], ENTITY_JOIN_M)):
            for r2 in {int(point_run[h]) for h in hits}:
                add(r, r2)
    # Consecutive runs on one SRI (a name change mid-route, e.g. "J F Kennedy Boulevard" →
    # "Kennedy Boulevard"): points are `STEP` apart, which can exceed `ENTITY_JOIN_M`.
    sri, lo, hi = runs['sri'].to_numpy(), runs['mp_lo'].to_numpy(), runs['mp_hi'].to_numpy()
    for r in range(n - 1):
        if sri[r] == sri[r + 1] and lo[r + 1] - hi[r] <= 2 * STEP + 1e-9:
            add(r, r + 1)
    # Same name + muni, ends within `ENTITY_GAP_M`.
    if 'muni' in runs:
        muni = runs['muni'].to_numpy()
        EX0, EY0 = to_meters(runs['lon0'].to_numpy(), runs['lat0'].to_numpy())
        EX1, EY1 = to_meters(runs['lon1'].to_numpy(), runs['lat1'].to_numpy())
        ends = cKDTree(np.r_[np.c_[EX0, EY0], np.c_[EX1, EY1]])
        pairs = ends.query_pairs(ENTITY_GAP_M, output_type='ndarray') % n
        mk = pd.Series(muni, dtype='string').fillna('').to_numpy()
        keep = (name_k[pairs[:, 0]] == name_k[pairs[:, 1]]) & (mk[pairs[:, 0]] == mk[pairs[:, 1]]) & (mk[pairs[:, 0]] != '')
        for a, b in pairs[keep]:
            add(a, b)
    if parent:
        by_sri = {s: grp for s, grp in runs[['sri', 'mp_lo', 'mp_hi']].assign(run=np.arange(n)).groupby('sri')}
        for s, grp in by_sri.items():
            p = parent.get(s)
            if p is None or p == s or p not in by_sri:
                continue
            pr = by_sri[p]
            for r, lo_, hi_ in zip(grp['run'], grp['mp_lo'], grp['mp_hi']):
                for r2 in pr['run'][(pr['mp_lo'] <= hi_) & (pr['mp_hi'] >= lo_)]:
                    add(r, r2)

    parent_arr = np.arange(n)

    def find(i):
        while parent_arr[i] != i:
            parent_arr[i] = parent_arr[parent_arr[i]]
            i = parent_arr[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent_arr[max(ra, rb)] = min(ra, rb)

    pairs = sorted(touch)
    # Phase 1: same-name touching runs.
    for a, b in pairs:
        if name_k[a] == name_k[b]:
            union(a, b)
    # Phase 2: one run's name is the other's major alias (sharing only an *alias* isn't enough:
    # NG911 aliases the North Bergen junction stretch of JFK Blvd "J F Kennedy Boulevard East",
    # which would otherwise fuse JFK Blvd with Boulevard East), *and* the alias covers ≥
    # `ALIAS_GROUP_FRAC` of the aliasing run's whole same-name road (phase-1 component): a 2-point
    # "Park Avenue" junction run aliased "Boulevard East" mustn't fuse Park Ave with Boulevard East.
    comp = np.array([find(i) for i in range(n)])
    size = np.bincount(point_run, minlength=n)
    comp_size = pd.Series(size).groupby(comp).sum()
    comp_alias: dict[tuple[int, str], int] = {}
    if names is not None and len(names):
        la = names[names['kind'] == 'L']
        # Spellings with one `merge_key` ("J F …" / "Jfk …") often tag the same points: max per run.
        ra = pd.DataFrame({'run': la['run'].to_numpy(), 'k': merge_key(la['value']).to_numpy(), 'n': la['n'].to_numpy()})
        ra = ra.groupby(['run', 'k'], as_index=False)['n'].max()
        comp_alias = ra.assign(comp=comp[ra['run'].to_numpy()]).groupby(['comp', 'k'])['n'].sum().to_dict()

    def aliased(r, k):
        """`k` is a major alias of run `r` and of its same-name road."""
        c = comp[r]
        return k in major[r] and comp_alias.get((c, k), 0) >= ALIAS_GROUP_FRAC * comp_size[c]

    # Direction variants ("East 48th Street" aliased "West 48th Street" by NG911) stay separate
    # entities: one right-of-way, grouped a level up (`road_model.road_corridors`).
    dir_k = dir_key(runs['name']).to_numpy()
    for a, b in pairs:
        if name_k[a] != name_k[b] and dir_k[a] != dir_k[b] and (aliased(a, name_k[b]) or aliased(b, name_k[a])):
            union(a, b)
    roots = np.array([find(i) for i in range(n)])
    first = pd.DataFrame({'root': roots, 'sri': runs['sri'].to_numpy(), 'mp_lo': runs['mp_lo'].to_numpy()})
    order = first.sort_values(['sri', 'mp_lo'], kind='stable').drop_duplicates('root')['root']
    ids = {root: i for i, root in enumerate(order)}
    return pd.Series([ids[r] for r in roots], index=runs.index, name='entity', dtype='int32')
