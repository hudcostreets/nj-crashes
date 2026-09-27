"""Road model v5 (specs/road-model-v5.md): chainage, corridors, intersection nodes, blocks.

- **Pieces / chainage** (`entity_pieces`, `chain_at`): an entity's runs, grouped by the SRI whose
  mileposts they're measured in (a secondary carriageway's parent) into contiguous *pieces*, are
  ordered end to end into one continuous, monotonic mile coordinate `chain` (0 at one end). Gaps
  between pieces count as their straight-line distance (capped at `CHAIN_MAX_GAP_MI`); chain runs
  the way the longest piece's MPs do.
- **Corridors** (`road_corridors`): entities that are one right-of-way: direction variants ("West
  48th Street" / "East 48th Street") or same-named roads touching end to end (a street split at a
  county line), and parallel lines of one route (a carriageway pair, co-signed lines: Tonnelle Ave /
  "US 1 SECONDARY"). Each member maps its chain onto the corridor's (`cchain = c0 + sign · chain`).
- **Intersection nodes** (`intersection_nodes`): NG9-1-1 segment ends where ≥ 3 legs of ≥ 2 road
  entities meet, merged within `NODE_MERGE_M` when they join the same roads (both carriageways of a
  divided road); each node's position (`chain`) on each of its roads.
- **Blocks** (`road_blocks`): each entity cut at its nodes (and its chain gaps).
- **Crash ↔ node** (`crash_nodes`): a crash is *at* a node of its road when its cross street names
  another road there and the police put it at (or within `X` of) the intersection, or (no usable
  cross street) its point is within `X` of a node and the police flagged it an intersection crash.
  `X` depends on the road class (`XS_M`); see the spec for the evidence.
"""
import numpy as np
import pandas as pd
import shapely
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from njdot.road_net import _locate, dir_key, lines_from, merge_key, to_meters

MI_M = 1609.344

# --- Pieces / chainage -------------------------------------------------------------------------

# An entity's runs on one MP reference SRI join into one piece across MP gaps up to this (`RUN_GAP_MP`).
PIECE_GAP_MP = 0.15
# Pieces whose ends are this close are "contiguous"; farther (up to `CHAIN_BRANCH_M`) a "gap".
CHAIN_JOIN_M = 60
CHAIN_BRANCH_M = 400
# The chain distance added between two pieces: their ends' distance, capped at this (miles).
CHAIN_MAX_GAP_MI = 0.25


def _order_pieces(p0: np.ndarray, p1: np.ndarray, lens: np.ndarray) -> list[tuple[int, int, float, str]]:
    """Chain order of one entity's pieces: `p0` / `p1` (k × 2, meters) each piece's low- / high-MP
    end, `lens` their lengths (mi). Starts at the end lowest along the ends' principal axis, then
    repeatedly appends the unvisited piece with an end nearest the current tail. Returns `(piece,
    dir, gap_mi, join)` per step, `dir` +1 when the piece runs low → high MP; the whole order is
    reversed if needed so the longest piece has `dir` +1."""
    k = len(lens)
    if k == 1:
        return [(0, 1, 0.0, 'start')]
    ends = np.r_[p0, p1]
    c = ends.mean(axis=0)
    _, _, vt = np.linalg.svd(ends - c, full_matrices=False)
    proj = (ends - c) @ vt[0]
    s = int(np.argmin(proj))
    first, d0 = s % k, (1 if s < k else -1)
    out = [(first, d0, 0.0, 'start')]
    tail = p1[first] if d0 == 1 else p0[first]
    left = set(range(k)) - {first}
    while left:
        cand = np.array(sorted(left))
        dl = np.hypot(*(p0[cand] - tail).T)
        dh = np.hypot(*(p1[cand] - tail).T)
        i_l, i_h = int(np.argmin(dl)), int(np.argmin(dh))
        if dl[i_l] <= dh[i_h]:
            q, dq, d = int(cand[i_l]), 1, float(dl[i_l])
        else:
            q, dq, d = int(cand[i_h]), -1, float(dh[i_h])
        join = 'contiguous' if d <= CHAIN_JOIN_M else 'gap' if d <= CHAIN_BRANCH_M else 'branch'
        out.append((q, dq, min(d / MI_M, CHAIN_MAX_GAP_MI), join))
        tail = p1[q] if dq == 1 else p0[q]
        left.remove(q)
    longest = int(np.argmax(lens))
    if next(d for p, d, _, _ in out if p == longest) == -1:
        # Reverse: the gap before step j is the one that preceded step j + 1 before.
        rev = out[::-1]
        gaps = [0.0] + [g for _, _, g, _ in out[:0:-1]]
        joins = ['start'] + [j for _, _, _, j in out[:0:-1]]
        out = [(p, -d, g, j) for (p, d, _, _), g, j in zip(rev, gaps, joins)]
    return out


def entity_pieces(runs: pd.DataFrame, parent: dict[str, str]) -> pd.DataFrame:
    """Runs (`entity, sri, mp_lo, mp_hi, mp_end, lon0, lat0, lon1, lat1`) → one row per piece:
    `entity, piece, sri, mp_lo, mp_hi, dir, chain_lo, chain_hi, join, gap_mi`, sorted `(entity,
    piece)`, `piece` = chain order. `sri` is the SRI the piece's MPs are measured in (a secondary
    carriageway's `parent`: both carriageways of a divided road are one piece); `[mp_lo, mp_hi]` its
    crash interval (runs' `[mp_lo, mp_end)`). `chain(mp) = chain_lo + (mp - mp_lo)` when `dir` is 1,
    `chain_lo + (mp_hi - mp)` when -1. `join`: how the piece meets the previous one (`start`,
    `contiguous` ≤ `CHAIN_JOIN_M`, `gap` ≤ `CHAIN_BRANCH_M`, `branch` farther), `gap_mi` the chain
    distance added before it."""
    r = runs[['entity', 'sri', 'mp_lo', 'mp_hi', 'mp_end', 'lon0', 'lat0', 'lon1', 'lat1']].copy()
    r['key'] = [parent.get(s, s) for s in r['sri']]
    r['pri'] = (r['sri'] != r['key']).astype(int)
    r = r.sort_values(['entity', 'key', 'mp_lo', 'pri'], kind='stable').reset_index(drop=True)
    grp = r['entity'].astype(str) + '|' + r['key']
    reach = r.groupby(grp)['mp_end'].cummax().groupby(grp).shift()
    new = grp.ne(grp.shift()) | (r['mp_lo'] > reach + PIECE_GAP_MP).fillna(True)
    r['p'] = new.cumsum() - 1
    agg = r.groupby('p').agg(entity=('entity', 'first'), key=('key', 'first'), mp_lo=('mp_lo', 'min'), mp_hi=('mp_end', 'max'))
    # Piece ends: the MP reference SRI's own runs where it has some (not a secondary's).
    lo_end = r.sort_values(['p', 'pri', 'mp_lo'], kind='stable').drop_duplicates('p').set_index('p')
    hi_end = r.sort_values(['p', 'pri', 'mp_hi'], ascending=[True, True, False], kind='stable').drop_duplicates('p').set_index('p')
    X0, Y0 = to_meters(lo_end.loc[agg.index, 'lon0'].to_numpy(), lo_end.loc[agg.index, 'lat0'].to_numpy())
    X1, Y1 = to_meters(hi_end.loc[agg.index, 'lon1'].to_numpy(), hi_end.loc[agg.index, 'lat1'].to_numpy())
    agg = agg.assign(x0=X0, y0=Y0, x1=X1, y1=Y1, len=agg['mp_hi'] - agg['mp_lo']).reset_index(drop=True)
    rows = []
    for ent, g in agg.groupby('entity', sort=True):
        idx = g.index.to_numpy()
        steps = _order_pieces(g[['x0', 'y0']].to_numpy(), g[['x1', 'y1']].to_numpy(), g['len'].to_numpy())
        c = 0.0
        for i, (q, d, gap, join) in enumerate(steps):
            row = agg.loc[idx[q]]
            c += gap
            rows.append((ent, i, row['key'], row['mp_lo'], row['mp_hi'], d, c, c + row['len'], join, gap))
            c += row['len']
    out = pd.DataFrame(rows, columns=['entity', 'piece', 'sri', 'mp_lo', 'mp_hi', 'dir', 'chain_lo', 'chain_hi', 'join', 'gap_mi'])
    return out.astype({
        'entity': 'int32', 'piece': 'int16', 'sri': 'string', 'mp_lo': 'float64', 'mp_hi': 'float64', 'dir': 'int8',
        'chain_lo': 'float64', 'chain_hi': 'float64', 'join': 'string', 'gap_mi': 'float32',
    })


def chain_at(entity: pd.Series, sri: pd.Series, mp: pd.Series, pieces: pd.DataFrame, parent: dict[str, str]) -> np.ndarray:
    """Chain (mi) of each `(entity, sri, mp)` (NaN where any is missing or no piece of the entity
    covers it): the piece of `entity` on `sri`'s MP reference SRI whose `[mp_lo, mp_hi]` holds `mp`
    (the last one starting at or before it), `mp` clipped into it."""
    n = len(entity)
    ent = pd.Series(entity).to_numpy(dtype='float64', na_value=np.nan)
    m = pd.Series(mp).to_numpy(dtype='float64', na_value=np.nan)
    s = pd.Series(sri).astype('string').to_numpy(dtype=object, na_value=None)
    ok = np.isfinite(ent) & np.isfinite(m) & np.array([v is not None for v in s], dtype=bool)
    out = np.full(n, np.nan)
    if not ok.any():
        return out
    q = pd.DataFrame({'i': np.flatnonzero(ok), 'entity': ent[ok].astype('int64'), 'key': [parent.get(v, v) for v in s[ok]], 'mp': m[ok]})
    q = q.sort_values('mp', kind='stable')
    p = pieces.assign(entity=pieces['entity'].astype('int64'), key=pieces['sri'].astype(str)).sort_values('mp_lo', kind='stable')
    j = pd.merge_asof(q, p[['entity', 'key', 'mp_lo', 'mp_hi', 'dir', 'chain_lo']], left_on='mp', right_on='mp_lo', by=['entity', 'key'])
    # Before the first piece's `mp_lo` (a crash MP a hair under its run's start): the first piece.
    miss = j['mp_lo'].isna()
    if miss.any():
        first = p.sort_values('mp_lo').drop_duplicates(['entity', 'key'])
        f = j.loc[miss, ['i', 'entity', 'key', 'mp']].merge(first[['entity', 'key', 'mp_lo', 'mp_hi', 'dir', 'chain_lo']], on=['entity', 'key'], how='left')
        j = pd.concat([j[~miss], f], ignore_index=True)
    j = j[j['mp_lo'].notna()]
    mm = np.clip(j['mp'].to_numpy(), j['mp_lo'].to_numpy(), j['mp_hi'].to_numpy())
    c = np.where(j['dir'].to_numpy() > 0, j['chain_lo'].to_numpy() + (mm - j['mp_lo'].to_numpy()), j['chain_lo'].to_numpy() + (j['mp_hi'].to_numpy() - mm))
    out[j['i'].to_numpy(dtype=int)] = c
    return out


# --- Corridors ---------------------------------------------------------------------------------

# Parallel lines: ≥ `PAR_FRAC` (and ≥ `PAR_MIN_PTS`) of the shorter entity's points within
# `PAR_M` of the other's, heading within ~25° (|cos| ≥ `PAR_COS`).
PAR_M = 40
PAR_FRAC = 0.6
PAR_MIN_PTS = 4
PAR_COS = 0.9
# Sequential members: an end of one within this of a point of the other (MP points are ~80 m apart).
SEQ_M = 100
RAMP_SUBT = 8


def _headings(geom: pd.DataFrame, X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    """Unit direction of each point (sorted `(sri, mp)`) from its neighbors on the same SRI."""
    sri = geom['sri'].to_numpy()
    n = len(sri)
    nxt = np.r_[np.arange(1, n), n - 1]
    prv = np.r_[0, np.arange(0, n - 1)]
    nxt = np.where(sri[nxt] == sri, nxt, np.arange(n))
    prv = np.where(sri[prv] == sri, prv, np.arange(n))
    dx, dy = X[nxt] - X[prv], Y[nxt] - Y[prv]
    norm = np.hypot(dx, dy)
    with np.errstate(invalid='ignore', divide='ignore'):
        return np.c_[np.where(norm > 0, dx / norm, 0), np.where(norm > 0, dy / norm, 0)]


def corridor_pairs(ents: pd.DataFrame, runs: pd.DataFrame, geom: pd.DataFrame, pieces: pd.DataFrame, parent: dict[str, str]) -> pd.DataFrame:
    """Entity pairs that are one right-of-way, `(a, b, kind)` with `a < b`, `kind` "sequential"
    (direction variants / same name, touching end to end: an end of one within `SEQ_M` of the
    other's points, or consecutive runs on one SRI) or "parallel" (see `PAR_*`; direction variants /
    same name, or sharing an SRI route number, e.g. `00000001__` / `00000001_S`). Ramps never pair."""
    e = ents.set_index('entity')
    dk = pd.Series(dir_key(e['name']).to_numpy(), index=e.index)
    ramp = e['subt'].ge(RAMP_SUBT)
    fam = runs.assign(f=runs['sri'].str[:8]).groupby('entity')['f'].agg(lambda s: frozenset(s))
    gent = geom['entity'].to_numpy()
    X, Y = to_meters(geom['lon'].to_numpy(), geom['lat'].to_numpy())
    keep = ~ramp.reindex(gent).fillna(True).to_numpy()
    tree_idx = np.flatnonzero(keep)
    tree = cKDTree(np.c_[X[tree_idx], Y[tree_idx]])
    npts = pd.Series(gent[keep]).value_counts()
    pairs: dict[tuple[int, int], str] = {}

    def named(a, b):
        return dk.get(a) is not None and not pd.isna(dk.get(a)) and dk.get(a) == dk.get(b)

    # Sequential: piece ends near the other's points, or consecutive runs on one SRI.
    ep = pd.concat([
        pieces[['entity', 'sri']].assign(mp=pieces['mp_lo']),
        pieces[['entity', 'sri']].assign(mp=pieces['mp_hi']),
    ], ignore_index=True).rename(columns={'sri': 'key'})
    # The end's point: the entity's point on that piece's MP reference SRI nearest that MP.
    g = pd.DataFrame({'i': np.arange(len(geom)), 'entity': gent, 'key': [parent.get(v, v) for v in geom['sri']], 'mp': geom['mp'].to_numpy()})
    g = g[keep]
    cand = ep.merge(g, on=['entity', 'key'], suffixes=('', '_g'))
    cand = cand.assign(dmp=(cand['mp_g'] - cand['mp']).abs()).sort_values(['entity', 'key', 'mp', 'dmp']).drop_duplicates(['entity', 'key', 'mp'])
    ci = cand['i'].to_numpy()
    for ent, hits in zip(cand['entity'].to_numpy(), tree.query_ball_point(np.c_[X[ci], Y[ci]], SEQ_M)):
        for o in {int(gent[tree_idx[h]]) for h in hits}:
            if o != ent and named(ent, o):
                pairs[(min(ent, o), max(ent, o))] = 'sequential'
    r = runs.sort_values(['sri', 'mp_lo'])
    same = (r['sri'].to_numpy()[1:] == r['sri'].to_numpy()[:-1]) & (r['mp_lo'].to_numpy()[1:] - r['mp_hi'].to_numpy()[:-1] <= 0.1 + 1e-9)
    ra, rb = r['entity'].to_numpy()[:-1][same], r['entity'].to_numpy()[1:][same]
    for a, b in zip(ra, rb):
        if a != b and not ramp.get(a, True) and not ramp.get(b, True) and named(a, b):
            pairs[(min(a, b), max(a, b))] = 'sequential'

    # Parallel.
    H = _headings(geom, X, Y)
    near = tree.query_ball_point(np.c_[X[tree_idx], Y[tree_idx]], PAR_M)
    src = np.repeat(tree_idx, [len(h) for h in near])
    dst = tree_idx[np.concatenate([np.asarray(h, dtype=int) for h in near])] if len(near) else np.array([], dtype=int)
    ok = (gent[src] != gent[dst]) & (np.abs((H[src] * H[dst]).sum(axis=1)) >= PAR_COS)
    m = pd.DataFrame({'a': gent[src][ok], 'b': gent[dst][ok], 'i': src[ok]}).drop_duplicates(['a', 'b', 'i'])
    cnt = m.groupby(['a', 'b']).size().rename('n').reset_index()
    cnt['frac'] = cnt['n'] / cnt['a'].map(npts).to_numpy()
    # Qualifies when the *shorter* entity's points mostly lie along the other.
    shorter = cnt['a'].map(npts).to_numpy() <= cnt['b'].map(npts).to_numpy()
    cnt = cnt[shorter & (cnt['n'] >= PAR_MIN_PTS) & (cnt['frac'] >= PAR_FRAC)]
    for a, b in zip(cnt['a'], cnt['b']):
        a, b = int(a), int(b)
        if named(a, b) or (fam.get(a, frozenset()) & fam.get(b, frozenset())):
            pairs.setdefault((min(a, b), max(a, b)), 'parallel')
    out = pd.DataFrame([(a, b, k) for (a, b), k in sorted(pairs.items())], columns=['a', 'b', 'kind'])
    return out.astype({'a': 'int32', 'b': 'int32', 'kind': 'string'})


def _strip_dir(name: str) -> str:
    """"West 48th Street" → "48th Street", "North Avenue East" → "North Avenue" (as `dir_key`)."""
    dirs = {'north', 'south', 'east', 'west', 'n', 's', 'e', 'w'}
    w = str(name).split()
    if len(w) > 2 and w[-1].lower().rstrip('.') in dirs:
        w = w[:-1]
    if len(w) > 2 and w[0].lower().rstrip('.') in dirs:
        w = w[1:]
    return ' '.join(w)


def road_corridors(ents: pd.DataFrame, pairs: pd.DataFrame, geom: pd.DataFrame, pieces: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Corridors: connected components (≥ 2 entities) of `corridor_pairs`. Returns `(corridors,
    members)`: `corridors` one row per corridor (`corridor` = component id here, `name`, `kind`
    "direction" / "parallel" / "mixed", `spine` entity, `chain_mi`, `length_mi`); `members` one row
    per member entity: `entity, corridor, role` ("spine" / "sequential" / "parallel"), `c0`,
    `sign`: its chain maps to the corridor's as `cchain = c0 + sign · chain`, and corridor chain
    starts at 0.

    The spine is the member with the longest chain; members are placed breadth-first from it:
    a parallel member by least-squares on its points' nearest placed points' corridor chains, a
    sequential one end to end past whichever corridor end it attaches nearer to."""
    if not len(pairs):
        return (pd.DataFrame(columns=['corridor', 'name', 'kind', 'spine', 'chain_mi', 'length_mi']),
                pd.DataFrame(columns=['entity', 'corridor', 'role', 'c0', 'sign']))
    ids = np.unique(np.r_[pairs['a'].to_numpy(), pairs['b'].to_numpy()])
    pos = {int(e): i for i, e in enumerate(ids)}
    a = np.array([pos[int(v)] for v in pairs['a']])
    b = np.array([pos[int(v)] for v in pairs['b']])
    adj = coo_matrix((np.ones(len(a)), (a, b)), shape=(len(ids), len(ids)))
    _, comp = connected_components(adj, directed=False)
    length = pieces.groupby('entity')['chain_hi'].max()
    name = ents.set_index('entity')['name']
    X, Y = to_meters(geom['lon'].to_numpy(), geom['lat'].to_numpy())
    gent = geom['entity'].to_numpy()
    gchain = geom['chain'].to_numpy()
    by_ent = pd.Series(np.arange(len(geom))).groupby(gent).indices
    edges: dict[int, list[tuple[int, str]]] = {}
    for x, y, k in zip(pairs['a'], pairs['b'], pairs['kind']):
        edges.setdefault(int(x), []).append((int(y), k))
        edges.setdefault(int(y), []).append((int(x), k))
    crow, mrows = [], []
    for c in range(comp.max() + 1):
        mem = [int(e) for e in ids[comp == c]]
        spine = max(mem, key=lambda e: (length.get(e, 0), -e))
        placed = {spine: (0.0, 1, 'spine')}
        queue = [spine]
        while queue:
            cur = queue.pop(0)
            for o, kind in sorted(edges.get(cur, [])):
                if o in placed:
                    continue
                pi = np.concatenate([by_ent.get(e, np.array([], dtype=int)) for e in placed])
                pc = np.concatenate([placed[e][0] + placed[e][1] * gchain[by_ent.get(e, np.array([], dtype=int))] for e in placed])
                oi = by_ent.get(o, np.array([], dtype=int))
                okp = np.isfinite(pc)
                pi, pc = pi[okp], pc[okp]
                if not len(oi) or not len(pi):
                    placed[o] = (0.0, 1, kind)
                    queue.append(o)
                    continue
                t = cKDTree(np.c_[X[pi], Y[pi]])
                d, j = t.query(np.c_[X[oi], Y[oi]])
                oc = gchain[oi]
                if kind == 'parallel':
                    m = (d <= PAR_M) & np.isfinite(oc)
                    if m.sum() >= 2 and np.std(oc[m]) > 0:
                        sign = 1 if np.corrcoef(oc[m], pc[j[m]])[0, 1] >= 0 else -1
                    else:
                        sign = 1
                    mm = m if m.any() else np.isfinite(oc)
                    c0 = float(np.median(pc[j[mm]] - sign * oc[mm]))
                else:
                    lo, hi = float(pc.min()), float(pc.max())
                    L = float(length.get(o, np.nanmax(oc) if np.isfinite(oc).any() else 0.0))
                    # The member's end nearest the placed geometry attaches; its corridor chain there.
                    k0 = int(np.nanargmin(np.where(np.isfinite(oc), d, np.inf)))
                    att_c = float(pc[j[k0]])
                    att_end0 = oc[k0] <= L / 2  # attaching end is the member's chain-0 end
                    gap = min(float(d[k0]) / MI_M, CHAIN_MAX_GAP_MI)
                    if abs(att_c - hi) <= abs(att_c - lo):
                        sign, c0 = (1, hi + gap) if att_end0 else (-1, hi + gap + L)
                    else:
                        sign, c0 = (-1, lo - gap) if att_end0 else (1, lo - gap - L)
                placed[o] = (c0, sign, kind)
                queue.append(o)
        lo_all = min(c0 + min(0.0, s * length.get(e, 0.0)) for e, (c0, s, _) in placed.items())
        spans = []
        for e, (c0, s, role) in placed.items():
            c0 = c0 - lo_all
            mrows.append((e, c, role, c0, s))
            L = length.get(e, 0.0)
            spans.append(sorted((c0, c0 + s * L)))
        spans.sort()
        covered, cur_lo, cur_hi = 0.0, None, None
        for lo_, hi_ in spans:
            if cur_hi is None or lo_ > cur_hi:
                covered += 0 if cur_hi is None else cur_hi - cur_lo
                cur_lo, cur_hi = lo_, hi_
            else:
                cur_hi = max(cur_hi, hi_)
        covered += cur_hi - cur_lo
        roles = {r for _, (_, _, r) in placed.items() if r != 'spine'}
        kind = 'direction' if roles == {'sequential'} else 'parallel' if roles == {'parallel'} else 'mixed'
        cname = name.get(spine)
        if kind != 'parallel':
            cname = _strip_dir(cname)
        crow.append((c, cname, kind, spine, max(h for _, h in spans), covered))
    corridors = pd.DataFrame(crow, columns=['corridor', 'name', 'kind', 'spine', 'chain_mi', 'length_mi'])
    members = pd.DataFrame(mrows, columns=['entity', 'corridor', 'role', 'c0', 'sign'])
    return (
        corridors.astype({'corridor': 'int32', 'name': 'string', 'kind': 'string', 'spine': 'int32', 'chain_mi': 'float32', 'length_mi': 'float32'}),
        members.astype({'entity': 'int32', 'corridor': 'int32', 'role': 'string', 'c0': 'float32', 'sign': 'int8'}).sort_values('entity').reset_index(drop=True),
    )


# --- Intersection nodes ------------------------------------------------------------------------

# NG911 segment ends this close are one point (NG911 is noded: usually 0).
NODE_SNAP_M = 1.0
# Nodes this close that join the same roads (by corridor) are one intersection: both carriageways
# of a divided road meeting a cross street, a cross street jogging across a road.
NODE_MERGE_M = 40
# NG911 names that don't make a leg a road.
UNNAMED = {'UNNAMEDSEGMENT', 'RAMP', 'UNNAMED', 'PRIVATE', 'PRIVATEROAD', 'DRIVEWAY'}


def intersection_nodes(
    seg: pd.DataFrame,
    iv: pd.DataFrame,
    seg_ent: pd.Series,
    ents: pd.DataFrame,
    corridor_of: dict[int, int],
    feats: pd.DataFrame,
    pieces: pd.DataFrame,
    parent: dict[str, str],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """NG911 segments (`ng_segments`), their accepted SRI intervals (`ng_intervals`) and entities
    (`seg_entities`) → `(nodes, node_ents, node_legs)`:

    - `nodes`: `node, x, y` (meters), `n_legs`, one row per intersection: an end point shared by
      ≥ 3 segment ends of ≥ 2 roads, ≥ 1 of them a (non-ramp) entity (a name change, 2 legs, isn't
      one). A leg's road is its entity's corridor (or the entity), else its NG911 name (a public
      road the network lacks or didn't match; not unnamed / ramp segments). Nodes within
      `NODE_MERGE_M` joining the same ≥ 2 roads merge.
    - `node_ents`: `node, entity, chain` — the node's position on each of its (non-ramp) roads, from
      its legs on that road (their segment's NJDOT line, located → MP → `chain_at`).
    - `node_legs`: `node, seg` — every segment end at the node (also those on no entity: their
      names still identify a cross street)."""
    subt = ents.set_index('entity')['subt']
    n = len(seg)
    P0 = np.array([(p.x, p.y) for p in seg['start'].to_numpy()])
    P1 = np.array([(p.x, p.y) for p in seg['end'].to_numpy()])
    P = np.r_[P0, P1]
    leg_seg = np.r_[np.arange(n), np.arange(n)]
    t = cKDTree(P)
    pr = t.query_pairs(NODE_SNAP_M, output_type='ndarray')
    adj = coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(P), len(P))) if len(pr) else coo_matrix((len(P), len(P)))
    _, cl = connected_components(adj, directed=False)
    se = seg_ent.to_numpy(dtype='float64', na_value=np.nan)
    ent_all = se[leg_seg]
    ramp = np.array([np.isfinite(e) and subt.get(int(e), RAMP_SUBT) >= RAMP_SUBT for e in ent_all], dtype=bool)
    # A leg's road: its (non-ramp) entity, mapped to its corridor; else its NG911 name (a public road
    # NJDOT's network lacks, or whose segment didn't match a line), unless unnamed or a ramp.
    ent_leg = np.where(ramp, np.nan, ent_all)
    nm = merge_key(seg['name']).to_numpy(dtype=object, na_value=None)[leg_seg]
    road = [
        f'c{corridor_of.get(int(e), -1 - int(e))}' if np.isfinite(e) else (None if r or v is None or v in UNNAMED else f'n{v}')
        for e, r, v in zip(ent_leg, ramp, nm)
    ]
    legs = pd.DataFrame({'cl': cl, 'seg': leg_seg, 'ent': ent_leg, 'road': road, 'x': P[:, 0], 'y': P[:, 1]})
    st = legs.groupby('cl').agg(n_legs=('seg', 'size'), n_ent=('ent', 'nunique'), n_road=('road', 'nunique'), x=('x', 'mean'), y=('y', 'mean'))
    raw = st[(st['n_legs'] >= 3) & (st['n_road'] >= 2) & (st['n_ent'] >= 1)]
    legs = legs[legs['cl'].isin(raw.index)]
    # Merge nearby raw nodes that join the same roads.
    rid = {c: i for i, c in enumerate(raw.index)}
    legs['r'] = legs['cl'].map(rid)
    keyset = legs.dropna(subset=['road']).groupby('r')['road'].agg(frozenset)
    RX = raw[['x', 'y']].to_numpy()
    rp = cKDTree(RX).query_pairs(NODE_MERGE_M, output_type='ndarray') if len(RX) else np.empty((0, 2), dtype=int)
    rp = np.array([(i, j) for i, j in rp if len(keyset.get(i, frozenset()) & keyset.get(j, frozenset())) >= 2], dtype=int).reshape(-1, 2)
    adj = coo_matrix((np.ones(len(rp)), (rp[:, 0], rp[:, 1])), shape=(len(RX), len(RX))) if len(rp) else coo_matrix((len(RX), len(RX)))
    _, node_of_raw = connected_components(adj, directed=False)
    legs['node'] = node_of_raw[legs['r'].to_numpy()]
    nodes = legs.groupby('node').agg(x=('x', 'mean'), y=('y', 'mean'), n_legs=('seg', 'size')).reset_index()
    node_legs = legs[['node', 'seg']].drop_duplicates().sort_values(['node', 'seg']).reset_index(drop=True)
    # Each (node, entity) leg's position: its segment end (the raw node point) located on its NJDOT line.
    le = legs.dropna(subset=['ent']).merge(iv[['seg', 'sri', 'fid']], on='seg')
    if len(le):
        lines = lines_from(list(feats['X']), list(feats['Y']), np.array([len(x) for x in feats['X']]))
        pts = shapely.points(le[['x', 'y']].to_numpy())
        mp = _locate(feats, le['fid'].to_numpy(dtype=int), pts, lines)
        le['chain'] = chain_at(le['ent'].astype('int64'), le['sri'], pd.Series(mp), pieces, parent)
    else:
        le['chain'] = pd.Series(dtype='float64')
    node_ents = le.groupby(['node', 'ent'], as_index=False)['chain'].mean().rename(columns={'ent': 'entity'})
    # Entities of the node with no locatable leg still count (chain NA).
    allne = legs.dropna(subset=['ent'])[['node', 'ent']].drop_duplicates().rename(columns={'ent': 'entity'})
    node_ents = allne.merge(node_ents, on=['node', 'entity'], how='left')
    node_ents = node_ents.astype({'node': 'int32', 'entity': 'int32', 'chain': 'float64'}).sort_values(['entity', 'chain', 'node']).reset_index(drop=True)
    return nodes.astype({'node': 'int32', 'n_legs': 'int16'}), node_ents, node_legs.astype({'node': 'int32', 'seg': 'int64'})


# --- Blocks ------------------------------------------------------------------------------------

# Block boundaries closer than this (mi) are one.
BLOCK_MIN_MI = 0.005


def road_blocks(node_ents: pd.DataFrame, pieces: pd.DataFrame) -> pd.DataFrame:
    """Each entity cut at its intersection nodes and its non-contiguous piece joins (`gap` /
    `branch`) → `entity, block, chain_lo, chain_hi, node_lo, node_hi` (nodes null at a road end or a
    gap), sorted `(entity, block)`."""
    ext = pieces.groupby('entity').agg(c0=('chain_lo', 'min'), c1=('chain_hi', 'max'))
    b = [
        pd.DataFrame({'entity': ext.index, 'c': ext['c0'].to_numpy(), 'node': pd.NA}),
        pd.DataFrame({'entity': ext.index, 'c': ext['c1'].to_numpy(), 'node': pd.NA}),
    ]
    gp = pieces[pieces['join'].isin(['gap', 'branch'])]
    b.append(pd.DataFrame({'entity': gp['entity'].to_numpy(), 'c': gp['chain_lo'].to_numpy(), 'node': pd.NA}))
    ne = node_ents.dropna(subset=['chain'])
    b.append(pd.DataFrame({'entity': ne['entity'].to_numpy(), 'c': ne['chain'].to_numpy(), 'node': ne['node'].to_numpy()}))
    cuts = pd.concat(b, ignore_index=True)
    cuts['node'] = cuts['node'].astype('Int32')
    cuts = cuts.sort_values(['entity', 'c', 'node'], na_position='last', kind='stable')
    # Collapse cuts closer than `BLOCK_MIN_MI` (keep a node over a bare end / gap).
    rows = []
    for ent, g in cuts.groupby('entity', sort=True):
        cs, ns = g['c'].to_numpy(), g['node'].to_numpy(dtype=object)
        keep_c, keep_n = [], []
        for c, nd in zip(cs, ns):
            if keep_c and c - keep_c[-1] < BLOCK_MIN_MI:
                if keep_n[-1] is pd.NA and nd is not pd.NA:
                    keep_n[-1] = nd
                continue
            keep_c.append(c)
            keep_n.append(nd)
        for i in range(len(keep_c) - 1):
            rows.append((ent, i, keep_c[i], keep_c[i + 1], keep_n[i], keep_n[i + 1]))
    out = pd.DataFrame(rows, columns=['entity', 'block', 'chain_lo', 'chain_hi', 'node_lo', 'node_hi'])
    return out.astype({'entity': 'int32', 'block': 'int32', 'chain_lo': 'float64', 'chain_hi': 'float64', 'node_lo': 'Int32', 'node_hi': 'Int32'})


# --- Crash ↔ node ------------------------------------------------------------------------------

# "At the intersection": within this far of the node, by the crash's road class (`subt`): about the
# distance from an intersection's center to its stop bars — local streets 50 ft, county roads (incl.
# 5xx routes) 75 ft, state / US / interstate 100 ft — which are also the round distances police
# report. See specs/road-model-v5.md § X for the evidence.
XS_FT = {1: 100, 2: 100, 3: 100, 4: 75, 5: 75, 6: 75, 7: 50}
XS_FT_DEFAULT = 50
# (+ 1 cm: a stated "50 FE" converts to exactly 50 ft.)
XS_M = {k: v * 0.3048 + 0.01 for k, v in XS_FT.items()}
XS_M_DEFAULT = XS_FT_DEFAULT * 0.3048 + 0.01
# A named cross street's node must be within this of the crash's point (else the name means
# another crossing of the two roads, or the point is off).
NAMED_MAX_M = 150
# An unplaced crash is pinned to its named node only if all candidate nodes lie within this.
PIN_SPREAD_M = 150
AT_FLAGS = ('I', 'Yes')


def node_keys(node_legs: pd.DataFrame, idx: pd.DataFrame, seg_ent: pd.Series, node_ents: pd.DataFrame) -> pd.DataFrame:
    """Names at each node, per road: `(entity, key, node, chain, leg_ent)` — for each road `entity`
    at the node (its `chain` there), the `ng_name_index` keys (`loc_key`s, route keys) of every *other*
    leg's segment (`leg_ent`: that leg's entity, NA when it's on none). A crash on `entity` whose
    cross street has one of these keys names this node."""
    k = node_legs.merge(idx[['seg', 'key']], on='seg')
    k['leg_ent'] = seg_ent.to_numpy(dtype='float64', na_value=np.nan)[k['seg'].to_numpy()]
    k = k.merge(node_ents, on='node')
    k = k[~(k['leg_ent'] == k['entity'])]
    k = k.drop_duplicates(['entity', 'key', 'node'])[['entity', 'key', 'node', 'chain', 'leg_ent']]
    return k.reset_index(drop=True)


def cross_keys(crashes: pd.DataFrame, idx: pd.DataFrame) -> pd.DataFrame:
    """Each crash's cross street (`split_road`: an "A / B" road string's B when there's none) →
    its candidate NG911 keys: the raw `loc_key`, `resolve_keys`'s matches in the crash's muni, and
    route keys ("RT 440" → `R:NJ440`, …). Rows `(i, key)`, `i` = position in `crashes`."""
    from njdot.loc_recovery import loc_key, resolve_keys, route_keys, split_road
    sp = split_road(crashes['road'], crashes['cross_street'])
    raw = loc_key(sp['cross'])
    base = pd.DataFrame({'cc': crashes['cc'].astype('Int64'), 'mc': pd.to_numeric(crashes['mc'], errors='coerce').astype('Int64')}, index=crashes.index)
    has = raw.notna().to_numpy()
    q = base[has].assign(key=raw[has])
    res = resolve_keys(q, idx) if len(q) else q.assign(ng_keys=None)
    rk = route_keys(sp['cross'][has])
    pos = np.flatnonzero(has)
    rows = []
    for i, k, ng, r in zip(pos, raw[has].to_numpy(dtype=object), res['ng_keys'].to_numpy(dtype=object), rk.to_numpy(dtype=object)):
        ks = {k}
        if ng:
            ks.update(ng)
        if r:
            ks.update(r)
        rows.extend((i, x) for x in ks)
    return pd.DataFrame(rows, columns=['i', 'key']).astype({'i': 'int64', 'key': 'string'})


def stated_m(crashes: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """The police's location relative to the cross street: `at` (the crash was flagged an
    intersection crash: `Intersection` "I" / AASHTO "Yes", or distance unit "AT") and the stated
    distance in meters (0 when `at`; NaN when unknown, e.g. AASHTO, which has no distance)."""
    from njdot.loc_recovery import offset_m
    flag = crashes['Intersection'].astype('string').str.strip() if 'Intersection' in crashes else pd.Series(pd.NA, index=crashes.index, dtype='string')
    unit = crashes['Unit Of Measurement'].astype('string').str.strip() if 'Unit Of Measurement' in crashes else pd.Series(pd.NA, index=crashes.index, dtype='string')
    at = (flag.isin(AT_FLAGS) | unit.eq('AT')).fillna(False).to_numpy(dtype=bool)
    dist = crashes['cross_street_distance'] if 'cross_street_distance' in crashes else pd.Series(np.nan, index=crashes.index)
    known = pd.to_numeric(dist, errors='coerce').notna() & unit.isin(['FE', 'FT', 'MI']).fillna(False)
    s = np.where(known.to_numpy(), offset_m(dist, unit).to_numpy(), np.nan)
    return at, np.where(at, 0.0, s)


def crash_nodes(
    by_entity: pd.DataFrame,
    nk: pd.DataFrame,
    node_ents: pd.DataFrame,
    idx: pd.DataFrame,
    subt: pd.Series,
    xs_m: dict[int, float] = XS_M,
) -> pd.DataFrame:
    """Each crash (`by_entity` rows: `entity`, `chain`, `cc`, `mc`, `road`, `cross_street`, and
    the police location fields `Intersection` / `cross_street_distance` / `Unit Of Measurement`) →
    the intersection node it's at, if any: `node` (Int32), `xs_how` ("named": its cross street
    names a road at the node; "geom": no usable cross street, flagged at an intersection and within
    `X` of the node), `xs_d_m` (along-road distance from its point to the node; NaN when unplaced),
    `xs_stated_m` (police distance; 0 at the intersection), and for unplaced crashes the node pins,
    `chain_lo` / `chain_hi` (the node's chain ± the stated distance). Index = `by_entity`'s.

    `X` = `xs_m[subt]` of the crash's road. Named: the crash is at the node if the police put it at
    the intersection or within `X` of it (stated distance), and — when it has a point — the point is
    within `NAMED_MAX_M` of the node (the nearest of the road's nodes with that cross street). AASHTO
    crashes (2023+) have no stated distance: not flagged, they're at the node if their point is
    within `X`."""
    n = len(by_entity)
    ent = by_entity['entity'].to_numpy(dtype='int64')
    chain = pd.Series(by_entity['chain']).to_numpy(dtype='float64', na_value=np.nan)
    at, st = stated_m(by_entity)
    X = np.array([xs_m.get(int(s), XS_M_DEFAULT) if not pd.isna(s) else XS_M_DEFAULT for s in subt.reindex(ent).to_numpy()], dtype=float)
    node = np.full(n, -1, dtype='int64')
    how = np.full(n, None, dtype=object)
    d_m = np.full(n, np.nan)
    c_lo, c_hi = np.full(n, np.nan), np.full(n, np.nan)

    # Named: the crash's cross-street keys at a node of its road.
    ck = cross_keys(by_entity, idx)
    if len(ck):
        ck['entity'] = ent[ck['i'].to_numpy()]
        cand = ck.merge(nk[['entity', 'key', 'node', 'chain']], on=['entity', 'key']).drop_duplicates(['i', 'node'])
        cand['dm'] = np.abs(chain[cand['i'].to_numpy()] - cand['chain'].to_numpy()) * MI_M
        placed = np.isfinite(chain[cand['i'].to_numpy()])
        pc = cand[placed].sort_values(['i', 'dm', 'node'], kind='stable').drop_duplicates('i')
        pc = pc[pc['dm'] <= NAMED_MAX_M]
        i = pc['i'].to_numpy()
        near = at[i] | (st[i] <= X[i]) | (np.isnan(st[i]) & (pc['dm'].to_numpy() <= X[i]))
        i, pc = i[near], pc[near]
        node[i], how[i], d_m[i] = pc['node'].to_numpy(), 'named', pc['dm'].to_numpy()
        # Unplaced: pinned when every candidate node is one place on the road.
        uc = cand[~placed].dropna(subset=['chain'])
        g = uc.groupby('i').agg(lo=('chain', 'min'), hi=('chain', 'max'), c=('chain', 'mean'), node=('node', 'first'), k=('node', 'nunique'))
        g = g[(g['hi'] - g['lo']) * MI_M <= PIN_SPREAD_M]
        i = g.index.to_numpy()
        s_mi = np.where(np.isnan(st[i]), np.nan, st[i] / MI_M)
        c_lo[i], c_hi[i] = g['c'].to_numpy() - s_mi, g['c'].to_numpy() + s_mi
        pin_at = at[i] | (st[i] <= X[i])
        j = i[pin_at & (g['k'].to_numpy() == 1)]
        node[j], how[j] = g.loc[j, 'node'].to_numpy(), 'named'

    # Geometric: flagged at an intersection, placed, no named node: the road's nearest node within X.
    todo = (node < 0) & at & np.isfinite(chain)
    ne = node_ents.dropna(subset=['chain'])
    if todo.any() and len(ne):
        q = pd.DataFrame({'i': np.flatnonzero(todo), 'entity': ent[todo], 'c': chain[todo]}).sort_values('c', kind='stable')
        r = ne.assign(entity=ne['entity'].astype('int64'), c=ne['chain'].astype('float64')).sort_values('c', kind='stable')[['entity', 'c', 'node']]
        m = pd.merge_asof(q, r.assign(nc=r['c']), on='c', by='entity', direction='nearest')
        m = m.dropna(subset=['node'])
        dm = np.abs(m['c'].to_numpy() - m['nc'].to_numpy()) * MI_M
        i = m['i'].to_numpy()
        ok = dm <= X[i]
        node[i[ok]], how[i[ok]], d_m[i[ok]] = m['node'].to_numpy()[ok].astype('int64'), 'geom', dm[ok]

    return pd.DataFrame({
        'node': pd.array(np.where(node >= 0, node, 0), dtype='Int32'),
        'xs_how': pd.array(how, dtype='string'),
        'xs_d_m': d_m.astype('float32'),
        'xs_stated_m': st.astype('float32'),
        'chain_lo': c_lo, 'chain_hi': c_hi,
    }, index=by_entity.index).assign(node=lambda d: d['node'].where(node >= 0))


# --- Build outputs -----------------------------------------------------------------------------

LABEL_MAX_ROADS = 4


def corridor_slugs(corridors: pd.DataFrame, members: pd.DataFrame, ents: pd.DataFrame) -> pd.Series:
    """Corridor → slug, as entity slugs (`road_outputs.entity_slugs`): `<county>/<muni>/<name>` when
    every member is within that one muni, `<county>/<name>` when all are in one county, else
    `nj/<name>`; collisions (ordered by the spine's slug) get `-2`, `-3`, …. Corridor slugs are their
    own namespace (a corridor may share its spine entity's slug)."""
    from njdot.road_outputs import slugify
    e = ents.set_index('entity')
    m = members.assign(cseg=members['entity'].map(e['slug'].str.split('/').str[0]), mc=members['entity'].map(e['mc']),
                       mseg=members['entity'].map(e['slug'].str.split('/').str[1]))
    g = m.groupby('corridor')
    one_c = g['cseg'].nunique() == 1
    one_m = (g['mc'].nunique() == 1) & g['mc'].apply(lambda s: s.notna().all())
    c = corridors.set_index('corridor')
    base = {}
    for cid in c.index:
        name = slugify(c.at[cid, 'name'])
        if one_c.get(cid, False):
            cs = g.get_group(cid)['cseg'].iloc[0]
            base[cid] = f'{cs}/{g.get_group(cid)["mseg"].iloc[0]}/{name}' if one_m.get(cid, False) else f'{cs}/{name}'
        else:
            base[cid] = f'nj/{name}'
    b = pd.DataFrame({'corridor': list(base), 'base': list(base.values())})
    b['spine_slug'] = b['corridor'].map(c['spine']).map(e['slug'])
    b = b.sort_values(['base', 'spine_slug'], kind='stable')
    b['k'] = b.groupby('base').cumcount()
    taken, out = set(b['base']), {}
    for cid, bs, k in zip(b['corridor'], b['base'], b['k']):
        if k == 0:
            out[cid] = bs
            continue
        i = k + 1
        while f'{bs}-{i}' in taken:
            i += 1
        taken.add(f'{bs}-{i}')
        out[cid] = f'{bs}-{i}'
    return pd.Series(out, name='slug').sort_index()


def _severity_counts(df: pd.DataFrame, keys: list[str], suffix: str = '') -> pd.DataFrame:
    """Crash counts per `keys`: `n_crashes, n_fatal, n_injury, n_killed` (+ `suffix`)."""
    c = df.assign(_f=df['severity'].eq('f').astype('int32'), _i=df['severity'].eq('i').astype('int32'), _k=pd.to_numeric(df['tk'], errors='coerce').fillna(0).astype('int32'))
    out = c.groupby(keys, as_index=False).agg(n_crashes=('_f', 'size'), n_fatal=('_f', 'sum'), n_injury=('_i', 'sum'), n_killed=('_k', 'sum'))
    return out.rename(columns={k: f'{k}{suffix}' for k in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed')})


def model_outputs(
    b: dict,
    ents: pd.DataFrame,
    by_entity: pd.DataFrame,
    idx: pd.DataFrame | None,
) -> dict:
    """Road model v5 over `road_outputs`' renumbered frames (`b`: `build_geom` output with `runs`
    / `geom` renumbered; `ents`: `entity, slug, name, subt, cc, mc`; `by_entity`: the crashes on
    entities, with the police location fields when loaded; `idx`: `ng_name_index`, or None: no
    cross-street matching). Adds `chain` to `b['geom']`; returns the new tables and `by_entity`
    with `chain`, `chain_lo`, `chain_hi`, `node` (and the internal `xs_how` / `xs_d_m` /
    `xs_stated_m`)."""
    from njdot.loc_recovery import seg_entities
    from njdot.loc_recovery import FROM_M
    runs, geom, parent = b['runs'], b['geom'], b.get('parent', {})
    pieces = entity_pieces(runs, parent)
    geom['chain'] = chain_at(geom['entity'], geom['sri'], geom['mp'], pieces, parent).astype('float32')
    placed = by_entity['mp'].notna().to_numpy()
    ch = chain_at(by_entity['entity'], by_entity['sri'], by_entity['mp'], pieces, parent)
    by_entity = by_entity.assign(chain=np.where(placed, ch, np.nan))

    pairs = corridor_pairs(ents, runs, geom, pieces, parent)
    corridors, members = road_corridors(ents, pairs, geom, pieces)
    if len(corridors):
        slugs = corridor_slugs(corridors, members, ents)
        order = {old: new for new, old in enumerate(slugs.sort_values(kind='stable').index)}
        corridors = corridors.assign(slug=corridors['corridor'].map(slugs)).assign(corridor=lambda d: d['corridor'].map(order)).sort_values('corridor').reset_index(drop=True)
        members = members.assign(corridor=members['corridor'].map(order))
    corridor_of = dict(zip(members['entity'].astype(int), members['corridor'].astype(int)))

    seg_ent = seg_entities(b['seg'], b['iv'], runs) if 'seg' in b else pd.Series(dtype='Int32')
    if 'seg' in b:
        nodes, node_ents, node_legs = intersection_nodes(b['seg'], b['iv'], seg_ent, ents, corridor_of, b['feats'], pieces, parent)
    else:
        nodes = pd.DataFrame({'node': pd.Series(dtype='int32'), 'x': [], 'y': [], 'n_legs': pd.Series(dtype='int16')})
        node_ents = pd.DataFrame({'node': pd.Series(dtype='int32'), 'entity': pd.Series(dtype='int32'), 'chain': []})
        node_legs = pd.DataFrame({'node': pd.Series(dtype='int32'), 'seg': pd.Series(dtype='int64')})
    # Node ids in S2 (level 16) order: `road-nodes` sorted by id is spatially clustered.
    from njdot.s2 import latlng_to_id
    lon, lat = FROM_M.transform(nodes['x'].to_numpy(), nodes['y'].to_numpy())
    nodes = nodes.assign(lon=np.asarray(lon), lat=np.asarray(lat))
    cell = latlng_to_id(nodes['lat'].to_numpy(), nodes['lon'].to_numpy(), 16) if len(nodes) else np.array([], dtype='uint64')
    renum = {old: new for new, old in enumerate(nodes['node'].to_numpy()[np.lexsort((nodes['lon'].to_numpy(), cell))])}
    nodes = nodes.assign(node=nodes['node'].map(renum)).sort_values('node').reset_index(drop=True)
    node_ents = node_ents.assign(node=node_ents['node'].map(renum))
    node_legs = node_legs.assign(node=node_legs['node'].map(renum))

    blocks = road_blocks(node_ents, pieces)
    subt = ents.set_index('entity')['subt']
    if idx is not None and len(node_legs):
        nk = node_keys(node_legs, idx, seg_ent, node_ents)
    else:
        nk = pd.DataFrame({'entity': pd.Series(dtype='int32'), 'key': pd.Series(dtype='string'), 'node': pd.Series(dtype='int32'), 'chain': [], 'leg_ent': []})
    xs = crash_nodes(by_entity, nk, node_ents, idx if idx is not None else pd.DataFrame(columns=['cc', 'mc', 'key', 'base']), subt)
    by_entity = by_entity.assign(**{c: xs[c] for c in xs.columns})
    for c in ('chain', 'chain_lo', 'chain_hi'):
        by_entity[c] = by_entity[c].astype('float32')
    return dict(
        pieces=pieces, pairs=pairs, corridors=corridors, members=members, nodes=nodes, node_ents=node_ents,
        node_legs=node_legs, blocks=blocks, by_entity=by_entity, seg_ent=seg_ent,
    )


def xs_rows(by_entity: pd.DataFrame, node_ents: pd.DataFrame, subt: pd.Series) -> pd.DataFrame:
    """Inclusive intersection rows: for each crash at a node (`by_entity.node`), one row per *other*
    (non-ramp) road at that node — the crash counted on that road too. `by_entity`'s columns with
    `entity` = the other road, `chain` = the node's chain on it (`chain_lo` / `chain_hi` null), plus
    `own_entity` (the road it's on)."""
    at = by_entity[by_entity['node'].notna().to_numpy()]
    x = at.rename(columns={'entity': 'own_entity'}).drop(columns=['chain']).merge(
        node_ents.rename(columns={'chain': 'chain'}), on='node')
    x = x[x['entity'].to_numpy() != x['own_entity'].to_numpy()]
    x = x[subt.reindex(x['entity'].to_numpy()).fillna(RAMP_SUBT).to_numpy() < RAMP_SUBT]
    x = x.assign(chain_lo=np.nan, chain_hi=np.nan)
    return x.reset_index(drop=True)


def block_stats(blocks: pd.DataFrame, by_entity: pd.DataFrame) -> pd.DataFrame:
    """`blocks` + its placed crashes' counts (`chain` in `[chain_lo, chain_hi)`; the road's last
    block includes its end): `n_crashes, n_fatal, n_injury, n_killed`."""
    c = by_entity[by_entity['chain'].notna().to_numpy()][['entity', 'chain', 'severity', 'tk']]
    b = blocks.sort_values(['entity', 'chain_lo']).reset_index(drop=True)
    q = c.assign(entity=c['entity'].astype('int64'), chain=c['chain'].astype('float64')).sort_values('chain', kind='stable')
    r = b[['entity', 'chain_lo', 'block']].assign(entity=b['entity'].astype('int64')).sort_values('chain_lo', kind='stable')
    m = pd.merge_asof(q, r, left_on='chain', right_on='chain_lo', by='entity')
    # Crashes a hair before the first block (chain rounding): the first block.
    m['block'] = m['block'].fillna(0).astype('int64')
    cnt = _severity_counts(m, ['entity', 'block'])
    out = b.merge(cnt, on=['entity', 'block'], how='left')
    for col in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        out[col] = out[col].fillna(0).astype('int32')
    return out


def node_table(nodes: pd.DataFrame, node_ents: pd.DataFrame, node_legs: pd.DataFrame, seg: pd.DataFrame, ents: pd.DataFrame, by_entity: pd.DataFrame, pt_cc_mc: tuple[np.ndarray, np.ndarray] | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """`road-nodes` (one row per node: `node, lon, lat, n_legs, n_roads, entities, label`, crash
    counts at it) and `road-node-entities` (one row per `(entity, node)`: `chain`, `cross` = the other
    roads' names, crashes at the node / of them on this road)."""
    e = ents.set_index('entity')
    ne = node_ents.assign(name=node_ents['entity'].map(e['name']), n=node_ents['entity'].map(e['n_crashes']).fillna(0))
    ne = ne.sort_values(['node', 'n', 'name'], ascending=[True, False, True], kind='stable')
    # NG911-only legs (roads without an entity) name the node too.
    extra = node_legs.assign(name=seg['name'].to_numpy()[node_legs['seg'].to_numpy()])
    names = pd.concat([ne[['node', 'name']], extra[['node', 'name']]], ignore_index=True).dropna()
    names['k'] = merge_key(names['name']).to_numpy()
    names = names[~names['k'].isin(UNNAMED)].drop_duplicates(['node', 'k'])
    label = names.groupby('node', sort=False)['name'].agg(lambda s: ' & '.join(list(s)[:LABEL_MAX_ROADS]))
    at = by_entity[by_entity['node'].notna().to_numpy()].assign(node=lambda d: d['node'].astype('int64'))
    cnt = _severity_counts(at, ['node'])
    own = at.groupby(['node', 'entity']).size().rename('n_own').reset_index()
    nodes = nodes.assign(
        n_roads=nodes['node'].map(ne.groupby('node').size()).fillna(0).astype('int16'),
        entities=nodes['node'].map(ne.groupby('node')['entity'].agg(lambda s: ','.join(map(str, sorted(s))))).astype('string'),
        label=nodes['node'].map(label).astype('string'),
    ).merge(cnt, on='node', how='left')
    for col in ('n_crashes', 'n_fatal', 'n_injury', 'n_killed'):
        nodes[col] = nodes[col].fillna(0).astype('int32')
    nodes = nodes[['node', 'lon', 'lat', 'n_legs', 'n_roads', 'entities', 'label', 'n_crashes', 'n_fatal', 'n_injury', 'n_killed']]
    # Per road: the other roads' names at each of its nodes.
    names = names.reset_index(drop=True).reset_index(names='o')
    x = ne[['node', 'entity', 'name']].assign(ke=merge_key(ne['name']).to_numpy()).merge(names[['node', 'o', 'name', 'k']].rename(columns={'name': 'other'}), on='node')
    x = x[x['k'].to_numpy() != x['ke'].to_numpy()].sort_values(['node', 'entity', 'o'], kind='stable')
    cross = x.groupby(['node', 'entity'])['other'].agg(lambda s: ' & '.join(list(s)[:LABEL_MAX_ROADS - 1])).rename('cross').reset_index()
    rne = ne[['entity', 'chain', 'node']].merge(cross, on=['node', 'entity'], how='left')
    rne['cross'] = rne['cross'].astype('string')
    rne = rne.merge(cnt[['node', 'n_crashes']], on='node', how='left').merge(own, on=['node', 'entity'], how='left')
    rne['n_crashes'] = rne['n_crashes'].fillna(0).astype('int32')
    rne['n_own'] = rne['n_own'].fillna(0).astype('int32')
    rne = rne.astype({'entity': 'int32', 'node': 'int32', 'chain': 'float32'}).sort_values(['entity', 'chain', 'node'], kind='stable').reset_index(drop=True)
    return nodes.astype({'node': 'int32', 'lon': 'float32', 'lat': 'float32'}), rne
