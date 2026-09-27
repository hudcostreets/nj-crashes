"""Recover road assignments for crashes without an SRI / milepost (specs/crash-location-recovery.md).

Before ~2018 NJDOT only coded an SRI + MP on crashes along routes its linear referencing system (LRS)
already covered: state, county and a few local streets. Most municipal-street crashes carry only
the police-reported `road`, `cross_street` and an offset from it (`cross_street_distance`,
`Unit Of Measurement`, `Direction From Cross Street`), so `njdot roads build` can't place them. This
module recovers a location from those strings against the NJOGIS NG9-1-1 centerlines:

- **Keys** (`loc_key`, `split_road`): crash strings and NG911 names → comparable keys (house numbers,
  `**` / "PARKING LOT" junk, spelled / split ordinals, street-type / direction abbreviations and
  doubled letters normalized; "A / B" → road A, cross street B).
- **Route strings** (`route_sri`, `route_keys`): "US 1 & 9", "RT 440", "ROUTE 501", "HUDSON COUNTY
  617" → the SRI NJDOT gives that route, and the NG911 shield keys it could be.
- **Name index** (`ng_name_index`): NG911 segments by `(cc, mc, key)`, from each side's county / muni and
  the segment's primary name, its abbreviated form, its local (`L`) aliases and its shields;
  `resolve_keys` looks crash keys up in it (exact, type-less, direction-less, fuzzy).
- **Learned names** (`learn_names`): road strings → entities, from the crashes NJDOT did code.
- **Intersections** (`meet_points`, `cluster_point`, `offset_along`): a road's and a cross street's
  segments in one muni → the point they meet (within `TOUCH_M`), moved `distance` along the road in the
  reported direction.
- **Snap** (`Snapper`): a point → the nearest NJDOT line of the road's SRIs (within `SNAP_M`) → `(sri,
  mp)`, and so an entity by the build's run intervals (`entity_at`).

`recover` runs them all and labels each crash's `loc_source` (`LOC_SOURCES`): `sri_mp` (as coded),
`intersection` (road + cross street geocoded), `route_xs` (route string / SRI without MP + cross
street), `latlon_snap` (a reported point snapped to the road), `sri_only` (an SRI without MP that is
one entity), `name_only` (the road name is one entity in the crash's muni; no point), or `none`.
"""
import re
from difflib import SequenceMatcher, get_close_matches

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer

from njdot.cc2mc2mn import CC2MC2MN
from njdot.road_net import _locate, lines_from, name_key, ng_segments, to_meters
from njdot.road_outputs import muni_codes

# Road / cross street segments "meet" if within this many meters (NG911 is noded, so usually 0).
TOUCH_M = 5
# An intersection's candidate points must lie within this many meters of each other; farther apart
# (a crescent meeting a street twice, or two same-named streets in one muni) is ambiguous.
CLUSTER_M = 150
# A geocoded point snaps to one of the road's NJDOT lines within this many meters.
SNAP_M = 30
# Offsets larger than this (feet) are typos or "0.5 MI" entered as feet; clamp rather than trust.
MAX_OFFSET_FT = 5280
FT_M = 0.3048
# An offset with no direction: place at the intersection if it's at most this far (meters).
UNDIRECTED_MAX_M = 61
MI_M = 1609.344
# Fuzzy key match (`difflib` ratio) within a muni's names; keys shorter than this don't fuzz.
FUZZ_CUTOFF = 0.88
FUZZ_MIN_LEN = 7

_ONES = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH']
_TEENS = {
    'TENTH': 10, 'ELEVENTH': 11, 'TWELFTH': 12, 'THIRTEENTH': 13, 'FOURTEENTH': 14, 'FIFTEENTH': 15,
    'SIXTEENTH': 16, 'SEVENTEENTH': 17, 'EIGHTEENTH': 18, 'NINETEENTH': 19,
}
_TENS = {'TWENTY': 20, 'THIRTY': 30, 'FORTY': 40, 'FIFTY': 50, 'SIXTY': 60, 'SEVENTY': 70, 'EIGHTY': 80, 'NINETY': 90}
_TENTHS = {'TWENTIETH': 20, 'THIRTIETH': 30, 'FORTIETH': 40, 'FIFTIETH': 50, 'SIXTIETH': 60, 'SEVENTIETH': 70, 'EIGHTIETH': 80, 'NINETIETH': 90}


def _suffix(n: int) -> str:
    if n % 100 in (11, 12, 13):
        return f'{n}TH'
    return f'{n}' + {1: 'ST', 2: 'ND', 3: 'RD'}.get(n % 10, 'TH')


ORDINALS: dict[str, str] = {w: _suffix(i) for i, w in enumerate(_ONES) if w}
ORDINALS |= {w: _suffix(n) for w, n in (_TEENS | _TENTHS).items()}
ORDINALS |= {f'{t} {o}': _suffix(tn + i) for t, tn in _TENS.items() for i, o in enumerate(_ONES) if o}
# Common misspellings in police-entered strings.
ORDINALS |= {'EIGHT': '8TH', 'NINETH': '9TH', 'TWELVETH': '12TH', 'TWENIETH': '20TH', 'FOURTYTH': '40TH'}
_ORD_RE = re.compile(r'\b(' + '|'.join(sorted(map(re.escape, ORDINALS), key=len, reverse=True)) + r')\b')

# Leading house number ("981 WESTSIDE AVE", "9-11 …", "12A …"), not an ordinal ("1ST AVE", "3 RD ST").
HOUSE_RE = r'^\d+[A-Z]?(-\d+[A-Z]?)?\s+(?!(ST|ND|RD|TH)\b)'
# Trailing / embedded junk in police-entered road strings.
JUNK_RE = r'\*+|\bPARKING LOT\b|\bPARKING AREA\b|\bLOT\b|\bP/L\b|\bIFO\b.*$|\bNEAR\b.*$|\bOPP\b.*$'
# Intersection-style values: "A / B", "A & B", "A AND B" ("US 1 & 9" / "1&9" are routes, handled
# first; not "AT": "AVENUE AT PORT IMPERIAL" is a street).
INTX_RE = r'\s*(?:/|&|\bAND\b)\s*'
# Route designations. Group 1: kind; group 2: number; group 3: suffix / second co-signed number.
ROUTE_KIND = (
    r'(?P<kind>US|U S|USHWY|US HWY|US HIGHWAY|US ROUTE|US RT|RT|RTE|ROUTE|NJ|NJ RT|NJ ROUTE|NJSH|SH|STATE HWY|STATE HIGHWAY|STATE ROUTE|SR|HWY|HIGHWAY'
    r'|I|INTERSTATE|CR|CO RD|CO RT|COUNTY RD|COUNTY ROAD|COUNTY RT|COUNTY ROUTE|[A-Z]+ COUNTY|[A-Z]+ CO)'
)
ROUTE_RE = re.compile(ROUTE_KIND + r'[ -]*(?P<num>\d{1,3})(?:\s*(?:&|/|-|AND)\s*\d{1,3})?(?P<sfx>[A-Z])?\b')
COUNTY_KINDS = {'CR', 'CO RD', 'CO RT', 'COUNTY RD', 'COUNTY ROAD', 'COUNTY RT', 'COUNTY ROUTE'}
# SRI suffixes of "US 1 TRUCK" / "NJ 139 UPPER" style variants.
ROUTE_SFX_WORDS = {'TRUCK': 'T', 'UPPER': 'U', 'ALT': 'A', 'BUS': 'B', 'SPUR': 'S'}


def ordinalize(s: pd.Series) -> pd.Series:
    """Spelled / split ordinals → "39TH": "THIRTY-NINTH ST", "THIRTY NINTH ST", "E 39 TH ST" → "… 39TH …"."""
    s = s.str.replace('-', ' ', regex=False).str.replace(r'\s+', ' ', regex=True)
    s = s.str.replace(_ORD_RE, lambda m: ORDINALS[m.group(1)], regex=True)
    return s.str.replace(r'\b(\d+) (ST|ND|RD|TH)\b', r'\1\2', regex=True)


def clean_road(s: pd.Series) -> pd.Series:
    """Police-entered road string → upper-case name: junk (`JUNK_RE`), a leading house number and
    punctuation dropped, whitespace collapsed; empty → NA."""
    s = s.astype('string').str.upper()
    s = s.str.replace(JUNK_RE, ' ', regex=True).str.replace(r'[^A-Z0-9/&@ \-\']', ' ', regex=True)
    s = s.str.replace(r'\s+', ' ', regex=True).str.strip()
    s = s.str.replace(HOUSE_RE, '', regex=True).str.strip()
    return s.where(s.str.len() > 0)


def loc_key(s: pd.Series) -> pd.Series:
    """A name → its match key: ordinals numeric, `name_key` (abbreviations, directions spelled out,
    spaces dropped), "JOHN F" → "J F", "JR" dropped, doubled *letters* squeezed ("TONNELLE" ==
    "TONNELE"; unlike `merge_key`, digits stay: "11TH" ≠ "1ST")."""
    u = ordinalize(s.astype('string').str.upper().str.replace('.', '', regex=False))
    u = u.str.replace(r'\bJOHN F\s', 'J F ', regex=True).str.replace(r'\b(JR|JUNIOR)\b', ' ', regex=True)
    u = u.str.replace(r'\bMLK\b', 'MARTIN LUTHER KING', regex=True).str.replace(r'^(DOCTOR|DR) (?=MARTIN)', '', regex=True)
    u = u.str.replace(r'\bLA$', 'LN', regex=True)
    u = u.str.replace(r"'", '', regex=False)
    k = name_key(u)
    k = k.str.replace(r'([A-Z])\1+', r'\1', regex=True)
    return k.where(k.str.len() > 0)


# Street-type words (after `name_key`'s abbreviation) stripped for the looser "base" key.
TYPE_RE = r'(AVE|ST|RD|BLVD|DR|PL|PKWY|HWY|LN|CT|TER|WAY|CIR|PLZ|SQ|EXT)$'


def base_key(k: pd.Series) -> pd.Series:
    """`loc_key` without a trailing street type ("WESTSIDEAVE" → "WESTSIDE"), for crash strings
    that omit it ("WESTSIDE")."""
    b = k.str.replace(TYPE_RE, '', regex=True)
    return b.where(b.str.len() >= 3)


def split_road(road: pd.Series, cross: pd.Series) -> pd.DataFrame:
    """Crash `road` / `cross_street` → `(road, cross)` cleaned names; an intersection-style `road`
    ("DUNCAN AVE / W SIDE AVE") gives the road its first part and, when `cross` is empty, the cross
    street its second. Route strings ("US 1 & 9") aren't split."""
    r, x = clean_road(road), clean_road(cross)
    is_route = r.str.match(ROUTE_RE.pattern).fillna(False).astype(bool)
    parts = r.str.split(INTX_RE, n=1, regex=True)
    first = parts.str[0].astype('string').str.strip()
    second = parts.str[1].astype('string').str.strip()
    split = ~is_route & second.notna() & (second.str.len() > 0)
    r = r.where(~split, first)
    x = x.where(~(split & x.isna()), second)
    return pd.DataFrame({'road': r, 'cross': x}, index=road.index)


def route_sri(s: pd.Series, cc: pd.Series) -> pd.Series:
    """Route strings → SRI: state / US / interstate and 500-series county routes are statewide
    (`00000501__`), other county routes county-prefixed (`09000617__`); a trailing "TRUCK" /
    "UPPER" / letter suffix fills the 9th character (`00000001T_`). Non-route strings → NA."""
    u = s.astype('string').str.upper().fillna('')
    out = []
    for v, c in zip(u.to_numpy(), cc.to_numpy()):
        m = ROUTE_RE.match(v)
        if not m:
            out.append(pd.NA)
            continue
        kind, num = m.group('kind'), int(m.group('num'))
        rest = v[m.end():].strip()
        sfx = m.group('sfx') or next((ROUTE_SFX_WORDS[w] for w in rest.split() if w in ROUTE_SFX_WORDS), None)
        county = kind in COUNTY_KINDS or kind.endswith(' COUNTY') or kind.endswith(' CO')
        if county and not 500 <= num < 600:
            if pd.isna(c):
                out.append(pd.NA)
                continue
            base = f'{int(c):02d}{num:06d}'
        else:
            base = f'{num:08d}'
        out.append(base + (f'{sfx}_' if sfx else '__'))
    return pd.Series(out, index=s.index, dtype='string')


# NG911 shield types → route-key prefixes (`route_keys`).
SHIELD_KEY = {'INT': 'I', 'USR': 'US', 'STR': 'NJ', 'COR': 'CR'}
US_KINDS = {'US', 'U S', 'USHWY', 'US HWY', 'US HIGHWAY', 'US ROUTE', 'US RT'}
NJ_KINDS = {'NJ', 'NJ RT', 'NJ ROUTE', 'NJSH', 'SH', 'STATE HWY', 'STATE HIGHWAY', 'STATE ROUTE'}
I_KINDS = {'I', 'INTERSTATE'}


def route_keys(s: pd.Series) -> pd.Series:
    """Route strings → candidate NG911 shield keys (`R:<type><number>`, as `ng_name_index` indexes
    segments' shields): "US 1 & 9" → (`R:US1`,), "HUDSON COUNTY 617" → (`R:CR617`,), and a bare "RT
    9" / "ROUTE 501" → every type it could be (`R:US9`, `R:NJ9`, `R:I9`; `R:CR501` too for the
    500s, which police call "Route 5xx"). Non-route strings → None."""
    out = []
    for v in s.astype('string').str.upper().fillna('').to_numpy():
        m = ROUTE_RE.match(v)
        if not m:
            out.append(None)
            continue
        kind, n = m.group('kind'), int(m.group('num'))
        if kind in COUNTY_KINDS or kind.endswith(' COUNTY') or kind.endswith(' CO'):
            ks = ('CR',)
        elif kind in US_KINDS:
            ks = ('US',)
        elif kind in NJ_KINDS:
            ks = ('NJ',)
        elif kind in I_KINDS:
            ks = ('I',)
        else:
            ks = ('US', 'NJ', 'I', 'CR') if 500 <= n < 600 else ('US', 'NJ', 'I')
        out.append(tuple(f'R:{k}{n}' for k in ks))
    return pd.Series(out, index=s.index, dtype=object)


def ng_name_index(cl: pd.DataFrame, al: pd.DataFrame, cc2mc2mn: CC2MC2MN) -> pd.DataFrame:
    """NG911 centerlines (+ alias rows) → `(seg, cc, mc, key, base, src)` rows, one per distinct
    `(segment, side's county / muni, key)`; `seg` indexes `ng_segments(cl)` (segments with ≥ 2
    vertices), `src` "name" (primary / abbreviated name), "alias" (a local `L` alias) or "route"
    (its own or an `H` alias's shield, keyed `R:<type><number>` as `route_keys`)."""
    df = cl[[len(x) >= 2 for x in cl['x']]].reset_index(drop=True)
    seg = pd.Series(np.arange(len(df)))
    names = pd.concat([
        pd.DataFrame({'rcl': df['RCL_NGUID'], 'seg': seg, 'name': df['PRIMENAME'], 'src': 'name'}),
        pd.DataFrame({'rcl': df['RCL_NGUID'], 'seg': seg, 'name': df['LST_PNAME'], 'src': 'name'}),
    ])
    la = al[al['ANAME_TYP'] == 'L']
    la = pd.concat([la[['RCL_NGUID', 'AST_PNAME']].rename(columns={'AST_PNAME': 'name'}), la[['RCL_NGUID', 'ALST_PNAME']].rename(columns={'ALST_PNAME': 'name'})])
    la = la.rename(columns={'RCL_NGUID': 'rcl'}).merge(names[['rcl', 'seg']].drop_duplicates(), on='rcl').assign(src='alias')
    names = pd.concat([names, la], ignore_index=True).dropna(subset=['name'])
    ha = al[al['ANAME_TYP'] == 'H'].rename(columns={'RCL_NGUID': 'rcl'}).merge(names[['rcl', 'seg']].drop_duplicates(), on='rcl')
    shields = pd.concat([
        pd.DataFrame({'seg': seg, 't': df['SHLD_TYPE'], 'n': df['SHLD_NUM']}),
        pd.DataFrame({'seg': ha['seg'], 't': ha['SHLD_TYPE'], 'n': ha['SHLD_NUM']}),
    ])
    shields = shields[shields['t'].isin(SHIELD_KEY) & shields['n'].notna()]
    num = pd.to_numeric(shields['n'].astype('string').str.extract(r'^(\d+)', expand=False), errors='coerce')
    shields = shields[num.notna()].assign(key=[f'R:{SHIELD_KEY[t]}{int(n)}' for t, n in zip(shields['t'][num.notna()], num.dropna())])
    sides = pd.concat([
        pd.DataFrame({'seg': seg, 'cc': df['cc_l'], 'muni': df['muni_l']}),
        pd.DataFrame({'seg': seg, 'cc': df['cc_r'], 'muni': df['muni_r']}),
    ]).dropna().drop_duplicates()
    sides['cc'] = sides['cc'].astype(int)
    codes = muni_codes(list({(int(c), m) for c, m in zip(sides['cc'], sides['muni'])}), cc2mc2mn)
    sides['mc'] = [codes.get((c, m), -1) for c, m in zip(sides['cc'], sides['muni'])]
    sides = sides[sides['mc'] >= 0]
    out = names.merge(sides[['seg', 'cc', 'mc']], on='seg')
    out['key'] = loc_key(out['name']).to_numpy()
    out = out.dropna(subset=['key'])
    out['base'] = base_key(out['key']).to_numpy()
    routes = shields[['seg', 'key']].merge(sides[['seg', 'cc', 'mc']], on='seg').assign(src='route', base=pd.NA)
    out = pd.concat([out, routes], ignore_index=True)
    out = out.sort_values(['seg', 'cc', 'mc', 'key', 'src'], ascending=[True, True, True, True, False])
    out = out.drop_duplicates(['seg', 'cc', 'mc', 'key'])
    return out[['seg', 'cc', 'mc', 'key', 'base', 'src']].astype({'cc': 'int8', 'mc': 'int16'}).reset_index(drop=True)


# A leading direction before a number ("SOUTH20THST"), or a trailing one after a street type
# ("PARKAVEEAST"); not "WESTSIDEAVE" → "SIDEAVE".
DIR_RE = r'^(?:NORTH|SOUTH|EAST|WEST)(?=\d)|(?:(?<=AVE)|(?<=ST)|(?<=RD)|(?<=BLVD)|(?<=DR)|(?<=PKWY))(?:NORTH|SOUTH|EAST|WEST)$'
# A fuzzy match must beat the runner-up by this `difflib` ratio margin.
FUZZ_MARGIN = 0.04


def nodir_key(k: pd.Series) -> pd.Series:
    """`loc_key` without a leading direction before a number ("SOUTH3RDST" → "3RDST") or a trailing
    one after a street type ("PARKAVEEAST" → "PARKAVE")."""
    d = k.str.replace(DIR_RE, '', regex=True)
    return d.where(d.str.len() >= 3)


def resolve_keys(q: pd.DataFrame, idx: pd.DataFrame, fuzz: bool = True) -> pd.DataFrame:
    """Crash name keys `q` (`cc, mc, key`, one row per query) → the NG911 key(s) each resolves to in
    its muni, first rule that applies: `how` "exact" (same `loc_key`); "base" (same `base_key`, and
    only one muni key has it: "WESTSIDE" → "WESTSIDEAVE"); "nodir" (same key once leading /
    trailing directions are dropped: "3RDST" → "NORTH3RDST", "SOUTH3RDST", all kept, for the cross
    street to disambiguate); "fuzzy" (`difflib` ratio ≥ `FUZZ_CUTOFF` and ≥ `FUZZ_MARGIN` ahead of
    the runner-up: "AUDIBONAVE" → "AUDUBONAVE"); else NA. Returns `q` + `ng_keys` (tuple) + `how`."""
    keys = idx[['cc', 'mc', 'key', 'base']].drop_duplicates()
    exact = set(zip(keys['cc'], keys['mc'], keys['key']))
    bases = keys.dropna(subset=['base']).groupby(['cc', 'mc', 'base'])['key'].agg(lambda k: tuple(sorted(set(k)))).to_dict()
    keys = keys.assign(nd=nodir_key(keys['key'].astype('string')).to_numpy())
    nodirs = keys.dropna(subset=['nd']).groupby(['cc', 'mc', 'nd'])['key'].agg(lambda k: tuple(sorted(set(k)))).to_dict()
    by_muni = keys.groupby(['cc', 'mc'])['key'].agg(lambda k: sorted(set(k))).to_dict()
    qk = q['key'].astype('string')
    qb, qn = base_key(qk).to_numpy(), nodir_key(qk).to_numpy()
    ng_keys, how = [], []
    cache: dict[tuple, tuple] = {}
    for c, m, k, b, n in zip(q['cc'].to_numpy(), q['mc'].to_numpy(), qk.to_numpy(), qb, qn):
        if pd.isna(k) or pd.isna(c) or pd.isna(m):
            ng_keys.append(None); how.append(pd.NA); continue
        t = (int(c), int(m), k)
        if t not in cache:
            r = (None, pd.NA)
            if t in exact:
                r = ((k,), 'exact')
            elif not pd.isna(b) and len(bk := bases.get((t[0], t[1], b), ())) == 1:
                r = (bk, 'base')
            elif not pd.isna(n) and (nk := nodirs.get((t[0], t[1], n), ())):
                r = (nk, 'nodir')
            elif fuzz and len(k) >= FUZZ_MIN_LEN:
                hits = get_close_matches(k, by_muni.get((t[0], t[1]), []), n=2, cutoff=FUZZ_CUTOFF)
                ratios = [SequenceMatcher(None, k, h).ratio() for h in hits]
                if hits and (len(hits) == 1 or ratios[0] - ratios[1] >= FUZZ_MARGIN):
                    r = ((hits[0],), 'fuzzy')
            cache[t] = r
        ng_keys.append(cache[t][0]); how.append(cache[t][1])
    return q.assign(ng_keys=pd.Series(ng_keys, index=q.index, dtype=object), how=pd.array(how, dtype='string'))


def meet_points(r_lines: np.ndarray, x_lines: np.ndarray, touch_m: float = TOUCH_M) -> np.ndarray:
    """Points (n × 2, meters) where any road line comes within `touch_m` of any cross-street line:
    their intersection points, else the midpoint of their shortest connecting line."""
    if not len(r_lines) or not len(x_lines):
        return np.empty((0, 2))
    tree = shapely.STRtree(x_lines)
    ri, xi = tree.query(r_lines, predicate='dwithin', distance=touch_m)
    pts = []
    for a, b in zip(r_lines[ri], x_lines[xi]):
        inter = shapely.intersection(a, b)
        if not inter.is_empty and inter.geom_type in ('Point', 'MultiPoint'):
            pts.extend(shapely.get_coordinates(inter).tolist())
        else:
            sl = shapely.shortest_line(a, b)
            pts.append(shapely.get_coordinates(shapely.line_interpolate_point(sl, 0.5, normalized=True))[0].tolist())
    return np.array(pts).reshape(-1, 2)


def cluster_point(pts: np.ndarray, max_spread: float = CLUSTER_M) -> np.ndarray | None:
    """The mean of `pts` if they all lie within `max_spread` of it, else None (ambiguous / none)."""
    if not len(pts):
        return None
    c = pts.mean(axis=0)
    return c if np.hypot(*(pts - c).T).max() <= max_spread else None


DIR_VEC = {'N': (0, 1), 'S': (0, -1), 'E': (1, 0), 'W': (-1, 0)}


def offset_along(lines: np.ndarray, p: np.ndarray, dist_m: float, direction: str | None) -> np.ndarray | None:
    """Move `dist_m` from point `p` along the nearest of `lines` (the road), toward `direction`
    (N/S/E/W, relative to the cross street). With no / unknown direction: `p` itself if `dist_m` ≤
    `UNDIRECTED_MAX_M`, else None; None too if the road doesn't run that way."""
    if dist_m <= 0:
        return p
    if direction not in DIR_VEC:
        return p if dist_m <= UNDIRECTED_MAX_M else None
    pt = shapely.points(p)
    line = lines[int(np.argmin(shapely.distance(lines, pt)))]
    t = shapely.line_locate_point(line, pt)
    cands = [shapely.line_interpolate_point(line, min(max(t + s * dist_m, 0), line.length)) for s in (-1, 1)]
    v = np.array(DIR_VEC[direction])
    scores = [float(np.dot(shapely.get_coordinates(c)[0] - p, v)) for c in cands]
    best = int(np.argmax(scores))
    return shapely.get_coordinates(cands[best])[0] if scores[best] > 0 else None


def offset_m(dist: pd.Series, unit: pd.Series) -> pd.Series:
    """`cross_street_distance` + `Unit Of Measurement` → meters: "FE" feet (clamped to
    `MAX_OFFSET_FT`), "MI" miles, "AT" / missing distance 0."""
    d = pd.to_numeric(dist, errors='coerce').fillna(0).astype(float)
    u = unit.astype('string').str.strip().fillna('')
    m = np.where(u == 'MI', d * MI_M, np.minimum(d, MAX_OFFSET_FT) * FT_M)
    return pd.Series(np.where(u == 'AT', 0.0, m), index=dist.index)


class Snapper:
    """Points (meters) → `(sri, mp, dist_m)` on NJDOT lines (`rn_features` output), optionally only
    lines of given SRIs; `entity_at` maps `(sri, mp)` to an entity by run intervals."""

    def __init__(self, feats: pd.DataFrame):
        self.feats = feats
        self.lines = lines_from(list(feats['X']), list(feats['Y']), np.array([len(x) for x in feats['X']]))
        self.tree = shapely.STRtree(self.lines)
        self.fsri = feats['sri'].to_numpy()

    def snap(self, p: np.ndarray, sris: set[str] | None = None, tol: float = SNAP_M) -> tuple[str, float, float] | None:
        pt = shapely.points(p)
        cand = self.tree.query(pt, predicate='dwithin', distance=tol)
        if sris is not None:
            cand = cand[np.isin(self.fsri[cand], list(sris))]
        if not len(cand):
            return None
        d = shapely.distance(self.lines[cand], pt)
        f = int(cand[np.argmin(d)])
        mp = float(_locate(self.feats, np.array([f]), np.array([pt]), self.lines)[0])
        return str(self.fsri[f]), round(mp, 3), float(d.min())


def entity_at(sri: pd.Series, mp: pd.Series, runs: pd.DataFrame) -> pd.Series:
    """`(sri, mp)` → the entity whose run interval `[mp_lo, mp_end)` on `sri` holds `mp` (as the
    build's `assign_crashes`), else NA."""
    q = pd.DataFrame({'sri': sri.to_numpy(), 'mp': mp.to_numpy(), 'i': np.arange(len(sri))}).dropna()
    m = q.merge(runs[['entity', 'sri', 'mp_lo', 'mp_end']], on='sri')
    m = m[(m['mp'] >= m['mp_lo']) & (m['mp'] < m['mp_end'])].drop_duplicates('i')
    out = pd.Series(pd.NA, index=np.arange(len(sri)), dtype='Int32')
    out.loc[m['i'].to_numpy()] = m['entity'].to_numpy()
    return out.set_axis(sri.index)


def seg_entities(seg: pd.DataFrame, iv: pd.DataFrame, runs: pd.DataFrame) -> pd.Series:
    """Each NG911 segment's entity: its accepted SRI interval's (`ng_intervals`) midpoint → `entity_at`."""
    mid = (iv['mp_lo'] + iv['mp_hi']) / 2
    ent = entity_at(iv['sri'], mid, runs)
    out = pd.Series(pd.NA, index=np.arange(len(seg)), dtype='Int32')
    out.loc[iv['seg'].to_numpy()] = ent.to_numpy()
    return out


LOC_SOURCES = ['sri_mp', 'intersection', 'route_xs', 'latlon_snap', 'sri_only', 'name_only', 'none']
# `road_system` 9: private property (parking lots, driveways): not on a road, never recovered (NJDOT
# codes almost none of them with an SRI either).
PRIVATE_ROAD_SYSTEM = 9
# A learned `(muni, road key)` → entity pair (`learn_names`) needs this many coded crashes, this
# share of them on its top entity.
LEARN_MIN_N = 5
LEARN_MIN_SHARE = 0.8


def learn_names(coded: pd.DataFrame, min_n: int = LEARN_MIN_N, min_share: float = LEARN_MIN_SHARE) -> pd.DataFrame:
    """Road strings → entities, learned from crashes NJDOT *did* locate (`cc, mc, road, entity`,
    entity from their SRI / MP): per `(cc, mc, loc_key(road))`, the top entity if it holds ≥
    `min_share` of ≥ `min_n` crashes. Catches what NG911 names miss ("COLUMBUS DR" → Christopher
    Columbus Drive; "ROUTE 501" → Kennedy Blvd). Intersection-style strings ("A / B") are skipped:
    either part may be the road. Rows `(cc, mc, key, entity, n, share)`."""
    c = coded.dropna(subset=['entity', 'cc', 'mc'])
    sp = split_road(c['road'], pd.Series(pd.NA, index=c.index, dtype='string'))
    single = sp['cross'].isna()
    k = pd.DataFrame({
        'cc': c['cc'].astype(int), 'mc': c['mc'].astype(int), 'key': loc_key(sp['road']), 'entity': c['entity'].astype(int),
    })[single.to_numpy()].dropna(subset=['key'])
    n = k.groupby(['cc', 'mc', 'key', 'entity']).size().rename('n').reset_index()
    tot = n.groupby(['cc', 'mc', 'key'])['n'].transform('sum')
    n['share'] = n['n'] / tot
    n = n.sort_values(['cc', 'mc', 'key', 'n', 'entity'], ascending=[True, True, True, False, True]).drop_duplicates(['cc', 'mc', 'key'])
    n = n[(tot.loc[n.index] >= min_n) & (n['share'] >= min_share)]
    n['n'] = tot.loc[n.index].to_numpy()
    return n[['cc', 'mc', 'key', 'entity', 'n', 'share']].astype({'cc': 'int8', 'mc': 'int16', 'entity': 'int32', 'n': 'int32'}).reset_index(drop=True)


def recover(
    crashes: pd.DataFrame,
    seg: pd.DataFrame,
    idx: pd.DataFrame,
    seg_ent: pd.Series,
    seg_sris: pd.Series,
    snapper: Snapper,
    runs: pd.DataFrame,
    learned: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Per crash (`cc, mc, sri, mp, road, cross_street, cross_street_distance, Unit Of Measurement,
    Direction From Cross Street`, optionally `road_system`, `ilat` / `ilon`, `olat` / `olon`):
    `loc_source` (`LOC_SOURCES`), `sri` / `mp` (as coded, or recovered), `lon` / `lat` (recovered
    points only), `entity` (`entity_at` the SRI / MP, or the one entity for `sri_only` / `name_only`),
    and `how`: the rule that resolved the road name (`resolve_keys`'s, "route", or "learned").

    Crashes coded with an SRI + MP keep them (`sri_mp`) unless the SRI is gone from the current
    network (`runs`: e.g. Hudson's pre-2018 county-route SRIs `09000617__` …), in which case they're
    re-located like uncoded ones (and keep their coded SRI / MP if that fails). Crashes on private
    property (`road_system` = `PRIVATE_ROAD_SYSTEM`) stay `none`.

    `seg` / `idx`: NG911 segments (`ng_segments`) and their `ng_name_index`; `seg_ent`: each
    segment's entity (`seg_entities`); `seg_sris`: each segment's accepted SRI (`ng_intervals`), NA
    if none; `snapper` / `runs`: the NJDOT lines and the build's run intervals; `learned`:
    `learn_names` output (road key → entity)."""
    lines = seg['line'].to_numpy()
    sp = split_road(crashes['road'], crashes['cross_street'])
    sri_in = crashes['sri'].astype('string').str.strip()
    has_sri = sri_in.fillna('').ne('')
    net = set(runs['sri'])
    coded = has_sri & crashes['mp'].notna()
    ok = coded & sri_in.isin(net).fillna(False)
    sri0 = sri_in.where(has_sri, route_sri(sp['road'], crashes['cc']))
    x_sri = route_sri(sp['cross'], crashes['cc'])
    r_rk, x_rk = route_keys(sp['road']), route_keys(sp['cross'])
    base = pd.DataFrame({'cc': crashes['cc'].astype('Int64'), 'mc': crashes['mc'].astype('Int64')}, index=crashes.index)
    r_raw = loc_key(sp['road'])
    rr = resolve_keys(base.assign(key=r_raw), idx)
    xr = resolve_keys(base.assign(key=loc_key(sp['cross'])), idx)
    # A split "A / B" road string: either part may be the road, so no name-only guess from it.
    split = crashes['road'].astype('string').str.contains(INTX_RE, regex=True).fillna(False) & ~sp['road'].str.match(ROUTE_RE.pattern).fillna(False)
    learned_ent: dict[tuple, int] = {}
    if learned is not None:
        learned_ent = {(int(c), int(m), k): int(e) for c, m, k, e in zip(learned['cc'], learned['mc'], learned['key'], learned['entity'])}
    segs_by = {k: np.unique(g.to_numpy()) for k, g in idx.groupby(['cc', 'mc', 'key'])['seg']}
    named = idx[idx['src'] == 'name']
    segs_named = {k: np.unique(g.to_numpy()) for k, g in named.groupby(['cc', 'mc', 'key'])['seg']}
    segs_cc = {k: np.unique(g.to_numpy()) for k, g in idx.groupby(['cc', 'key'])['seg']}
    ent_sris = runs.groupby('entity')['sri'].agg(lambda s: frozenset(s)).to_dict()
    # An SRI all of whose runs are one entity (most local SRIs): an SRI without MP is still on it.
    sri_ent = runs.groupby('sri')['entity'].agg(lambda e: int(e.iloc[0]) if e.nunique() == 1 else None).dropna().to_dict()
    off = offset_m(crashes['cross_street_distance'], crashes['Unit Of Measurement']).round(1)
    dirn = crashes['Direction From Cross Street'].astype('string').str.strip().str.upper().fillna('')
    need = set(sri0.dropna()) | set(x_sri.dropna()) | {s for e in set(learned_ent.values()) for s in ent_sris.get(e, ())}
    sri_lines = {s: snapper.lines[np.flatnonzero(snapper.fsri == s)] for s in need}
    ctx = dict(
        lines=lines, segs_by=segs_by, segs_named=segs_named, segs_cc=segs_cc, seg_ent=seg_ent, seg_sris=seg_sris,
        sri_lines=sri_lines, ent_sris=ent_sris, sri_ent=sri_ent, snapper=snapper,
    )
    private = crashes['road_system'].eq(PRIVATE_ROAD_SYSTEM).fillna(False).to_numpy() if 'road_system' in crashes else np.zeros(len(crashes), dtype=bool)
    pts = _points(crashes)

    n = len(crashes)
    src = np.where(coded.to_numpy(), 'sri_mp', 'none').astype(object)
    sri = sri_in.where(coded).to_numpy(dtype=object)
    mp = crashes['mp'].where(coded).astype('float64').to_numpy()
    lon, lat = np.full(n, np.nan), np.full(n, np.nan)
    ent = np.full(n, pd.NA, dtype=object)
    how = rr['how'].to_numpy(dtype=object)
    cache: dict[tuple, tuple] = {}
    for i in np.flatnonzero(~ok.to_numpy() & ~private):
        c, m = base['cc'].iat[i], base['mc'].iat[i]
        if pd.isna(c) or pd.isna(m):
            continue
        c, m = int(c), int(m)
        # Route strings ("RT 440", "HUDSON COUNTY 617") → the NG911 shield keys present in the muni.
        r_keys, x_keys = rr['ng_keys'].iat[i], xr['ng_keys'].iat[i]
        if r_rk.iat[i]:
            r_keys = tuple(k for k in r_rk.iat[i] if (c, m, k) in segs_by) or r_keys
        if x_rk.iat[i]:
            x_keys = tuple(k for k in x_rk.iat[i] if (c, m, k) in segs_by or (c, k) in segs_cc) or x_keys
        le = None if split.iat[i] or pd.isna(r_raw.iat[i]) else learned_ent.get((c, m, r_raw.iat[i]))
        pt = (round(float(pts[i, 0]), 1), round(float(pts[i, 1]), 1)) if np.isfinite(pts[i]).all() else None
        key = (
            c, m, r_keys, x_keys, sri0.iat[i], x_sri.iat[i], off.iat[i], dirn.iat[i], le, bool(split.iat[i]),
            bool(r_rk.iat[i]), pt,
        )
        if key not in cache:
            cache[key] = _locate_one(*key, **ctx)
        res, s_i, mp_i, q, e = cache[key]
        if res == 'none' and coded.iat[i]:
            continue  # a retired SRI we couldn't re-locate: keep it as coded
        src[i] = res
        if r_rk.iat[i] and res != 'none':
            how[i] = 'route'
        elif le is not None and res in ('intersection', 'name_only'):
            how[i] = 'learned'
        sri[i], mp[i] = (s_i, np.nan if mp_i is None else mp_i) if s_i is not None else (pd.NA, np.nan)
        if q is not None:
            lon[i], lat[i] = _to_lonlat(q)
        if e is not None:
            ent[i] = e
    df = pd.DataFrame({'loc_source': src, 'sri': sri, 'mp': mp, 'lon': lon, 'lat': lat}, index=crashes.index)
    placed = df['sri'].notna() & df['mp'].notna() & ~df['loc_source'].isin(['name_only', 'sri_only'])
    at = entity_at(df['sri'].astype('string')[placed], df['mp'][placed], runs)
    ent = pd.Series(ent, index=crashes.index, dtype=object)
    ent[placed] = at.to_numpy(dtype=object)
    df['entity'] = pd.array([None if pd.isna(e) else int(e) for e in ent], dtype='Int32')
    df['loc_source'] = pd.Categorical(df['loc_source'], categories=LOC_SOURCES)
    df['sri'] = df['sri'].astype('string')
    df['mp'] = df['mp'].astype('float32')
    df['how'] = pd.array(how, dtype='string')
    df.loc[ok.to_numpy(), 'how'] = pd.NA
    return df


def _points(crashes: pd.DataFrame) -> np.ndarray:
    """Each crash's reported point in meters (n × 2; NaN where none): `ilat` / `ilon` (NJDOT's, from
    its SRI / MP), else `olat` / `olon` (the police report's) inside NJ."""
    n = len(crashes)
    lat = pd.Series(np.nan, index=crashes.index)
    lon = pd.Series(np.nan, index=crashes.index)
    if 'ilat' in crashes:
        lat, lon = crashes['ilat'].astype(float), crashes['ilon'].astype(float)
    if 'olat' in crashes:
        olat, olon = crashes['olat'].astype(float), crashes['olon'].astype(float)
        inside = olat.between(38.9, 41.4) & olon.between(-75.7, -73.9)
        lat, lon = lat.fillna(olat.where(inside)), lon.fillna(olon.where(inside))
    out = np.full((n, 2), np.nan)
    has = (lat.notna() & lon.notna()).to_numpy()
    if has.any():
        X, Y = to_meters(lon.to_numpy()[has], lat.to_numpy()[has])
        out[has] = np.c_[X, Y]
    return out


FROM_M = Transformer.from_crs(32118, 4326, always_xy=True)


def _to_lonlat(p: np.ndarray) -> tuple[float, float]:
    return FROM_M.transform(float(p[0]), float(p[1]))


_EMPTY = np.array([], dtype=int)


def _segs(keys: tuple | None, c: int, m: int, segs_by: dict, segs_cc: dict | None = None) -> np.ndarray:
    """Segments named any of `keys` in muni `(c, m)` (else, with `segs_cc`, anywhere in county `c`)."""
    if not keys:
        return _EMPTY
    s = [segs_by[(c, m, k)] for k in keys if (c, m, k) in segs_by]
    if not s and segs_cc is not None:
        s = [segs_cc[(c, k)] for k in keys if (c, k) in segs_cc]
    return np.unique(np.concatenate(s)) if s else _EMPTY


def _locate_one(
    c, m, r_keys, x_keys, r_sri, x_sri, off, dirn, learned_ent, split, is_route, pt, *,
    lines, segs_by, segs_named, segs_cc, seg_ent, seg_sris, sri_lines, ent_sris, sri_ent, snapper,
):
    """One `(muni, road keys, cross keys, road route SRI, cross route SRI, offset, direction, learned
    entity, split road string, road is a route string, reported point)` → `(loc_source, sri, mp,
    point, entity)`; `entity` is set only for `sri_only` / `name_only` (placed crashes get theirs
    from `entity_at`). In order: the road meets the cross street (`intersection` / `route_xs`); the
    reported point snaps to the road's lines (`latlon_snap`); the SRI is one entity (`sri_only`);
    the name is one entity (`name_only`)."""
    none = ('none', None, None, None, None)
    if split:
        # "A / B": either part may be the road (both at their intersection); 2018+ coded crashes
        # with such strings sit on A only ~75-90% of the time, so they're left unassigned.
        return none
    r_segs = _segs(r_keys, c, m, segs_by)
    route_ok = not pd.isna(r_sri) and len(sri_lines.get(r_sri, ()))
    if route_ok:
        # A route string (or a coded SRI without MP): the route's NJDOT lines.
        r_lines, r_sris = sri_lines[r_sri], {r_sri}
    elif len(r_segs):
        r_lines, r_sris = lines[r_segs], set(seg_sris.iloc[r_segs].dropna())
    elif learned_ent is not None and ent_sris.get(learned_ent):
        # A name only crash strings know (learned): the entity's SRIs' lines.
        r_sris = set(ent_sris[learned_ent])
        r_lines = np.concatenate([sri_lines[s] for s in r_sris if s in sri_lines] or [np.array([], dtype=object)])
    else:
        r_lines, r_sris = np.array([], dtype=object), set()
    kind = 'route_xs' if route_ok or is_route else 'intersection'
    if not pd.isna(x_sri) and len(sri_lines.get(x_sri, ())):
        x_lines = sri_lines[x_sri]
    else:
        x_segs = _segs(x_keys, c, m, segs_by, segs_cc)
        x_lines = lines[x_segs] if len(x_segs) else np.array([], dtype=object)
    conflict = False
    if len(x_lines) and len(r_lines):
        meets = meet_points(r_lines, x_lines)
        # The named cross street never meets the named road here: one of the names is wrong (or
        # means another street), so no name-only guess either.
        conflict = not len(meets)
        p = cluster_point(meets)
        if p is not None and r_sris:
            q = offset_along(r_lines, p, off, dirn)
            if q is not None:
                # Only the road's own SRIs: at an intersection the cross street's line is as near.
                hit = snapper.snap(q, r_sris)
                if hit is not None:
                    return (kind, hit[0], hit[1], q, None)
    if pt is not None and r_sris:
        hit = snapper.snap(np.array(pt), r_sris)
        if hit is not None:
            return ('latlon_snap', hit[0], hit[1], np.array(pt), None)
    if route_ok:
        e = sri_ent.get(r_sri)
        return ('sri_only', r_sri, None, None, e) if e is not None else none
    if conflict or is_route:
        return none
    if learned_ent is not None:
        return ('name_only', None, None, None, learned_ent)
    # NG911: the entity of the segments carrying the name as their own (not an alias), else any.
    for segs in (_segs(r_keys, c, m, segs_named), r_segs):
        ents = set(seg_ent.iloc[segs].dropna()) if len(segs) else set()
        if len(ents) == 1:
            return ('name_only', None, None, None, next(iter(ents)))
        if len(ents) > 1:
            break
    return none
