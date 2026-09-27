"""Road anomaly audit (`njdot roads audit-anomalies`; specs/road-model-v5.md § Anomaly audit): a
ranked review queue of roads whose crash counts look like data quirks rather than traffic.

- **`yoy`** (`yoy_breaks`): a run of years whose count departs from the road's own neighboring years
  (`YOY_WINDOW` on each side, median), after scaling by the rest of its county's total that year
  (so 2020's statewide drop isn't flagged). Score: the run's summed Poisson z.
- **`unplaced`** (`unplaced_share`): roads where many crashes are on it by street name / SRI only
  (no map point): a name that may be resolving to the wrong road, or a road NJDOT's network misses.
- **`pair_swing`** (`pair_swings`): two roads meeting at intersections (or in one corridor) whose
  split of the crashes between them swings by year: police in some years putting the other street
  in `road` (the cross-street attribution convention), or NJDOT coding one street's crashes on the
  other's SRI. Score: χ² of the per-year split against the pooled one.
- **`corridor_yoy`**: `yoy` on corridors (`road-corridor-summary`). A corridor absorbs its members'
  swings (a carriageway's crashes recoded to its express lanes), so a member's `yoy` finding, or a
  `pair_swing` of two members, is dropped when its corridor has no `corridor_yoy` finding in those
  years (`absorbed`): the corridor's series is continuous.

A `yoy` finding a data note explains (`noted`: `road-notes`, e.g. a town's reports missing those
years) is dropped too.
"""
import numpy as np
import pandas as pd

# yoy: a road needs this many crashes in all to be checked; a year is compared with the median of
# up to `YOY_WINDOW` years on each side (≥ `YOY_MIN_NEIGHBORS` of them with data).
YOY_MIN_TOTAL = 300
YOY_WINDOW = 3
YOY_MIN_NEIGHBORS = 4
# A year is off when observed / expected is outside `[1 / YOY_RATIO, YOY_RATIO]` and differs by ≥ `YOY_MIN_DIFF`.
YOY_RATIO = 2.0
YOY_MIN_DIFF = 25
# unplaced: roads with ≥ this many crashes, ≥ this share of them without a map point.
UNPLACED_MIN_N = 100
UNPLACED_MIN_SHARE = 0.3
# pair_swing: pairs with ≥ this many shared crashes, years with ≥ `SWING_MIN_YEAR` of them; flagged
# when the per-year share on the first road spans ≥ `SWING_MIN_RANGE`.
SWING_MIN_N = 60
SWING_MIN_YEAR = 8
SWING_MIN_RANGE = 0.5
QUEUE_COLS = ['kind', 'score', 'slug', 'name', 'other_slug', 'years', 'observed', 'expected', 'detail']


def yoy_breaks(
    summary: pd.DataFrame,
    ents: pd.DataFrame,
    years: tuple[int, int] | None = None,
    scale_summary: pd.DataFrame | None = None,
    scale_ents: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """`road-summary` (`entity, year, severity, n`) + `road-entities` (`entity, slug, name, cc`) →
    one row per run of consecutive anomalous years per road (see module docstring). The county /
    state totals that scale each road's expectation come from `scale_summary` / `scale_ents` when
    given (corridors: the roads' totals), else from `summary` / `ents`."""
    n = summary.groupby(['entity', 'year'])['n'].sum().rename('n').reset_index()
    tot = n.groupby('entity')['n'].sum()
    big = tot[tot >= YOY_MIN_TOTAL].index
    n = n[n['entity'].isin(big)]
    y0, y1 = years or (int(summary['year'].min()), int(summary['year'].max()))
    ys = np.arange(y0, y1 + 1)
    grid = n.pivot(index='entity', columns='year', values='n').reindex(columns=ys).fillna(0)
    cc = ents.set_index('entity')['cc'].reindex(grid.index)
    # County totals per year (all roads), to scale each road's expectation by its county's trend; a
    # road in no one county (a statewide corridor) by the state's.
    scale = summary if scale_summary is None else scale_summary
    sents = ents if scale_ents is None else scale_ents
    allc = scale.merge(sents[['entity', 'cc']], on='entity').groupby(['cc', 'year'])['n'].sum().unstack().reindex(columns=ys).fillna(0)
    state = scale.groupby('year')['n'].sum().reindex(ys).fillna(0).to_numpy(dtype=float)
    rows = []
    vals = grid.to_numpy()
    for k, ent in enumerate(grid.index):
        v = vals[k]
        # The county's other roads (not this one: its own break would damp its expectation).
        c = (allc.loc[cc[ent]].to_numpy(dtype=float) if not pd.isna(cc[ent]) and cc[ent] in allc.index else state) - v
        # Only years the road "exists" in the data: from its first to its last non-zero year.
        nz = np.flatnonzero(v > 0)
        if not len(nz):
            continue
        lo, hi = nz[0], nz[-1]
        flags = np.zeros(len(ys), dtype=bool)
        exp = np.full(len(ys), np.nan)
        for j in range(lo, hi + 1):
            nb = [i for i in range(max(lo, j - YOY_WINDOW), min(hi, j + YOY_WINDOW) + 1) if i != j and c[i] > 0]
            if len(nb) < YOY_MIN_NEIGHBORS or c[j] <= 0:
                continue
            # The neighbors' counts scaled to this year's county volume.
            e = float(np.median([v[i] * c[j] / c[i] for i in nb]))
            exp[j] = e
            r = (v[j] + 1) / (e + 1)
            flags[j] = (r >= YOY_RATIO or r <= 1 / YOY_RATIO) and abs(v[j] - e) >= YOY_MIN_DIFF
        j = 0
        while j < len(ys):
            if not flags[j]:
                j += 1
                continue
            k2 = j
            direction = np.sign(v[j] - exp[j])
            while k2 + 1 < len(ys) and flags[k2 + 1] and np.sign(v[k2 + 1] - exp[k2 + 1]) == direction:
                k2 += 1
            obs, e = v[j:k2 + 1], exp[j:k2 + 1]
            z = float(np.sum(np.abs(obs - e) / np.sqrt(e + 1)))
            rows.append(dict(
                kind='yoy', score=round(z, 1), entity=int(ent), years=f'{ys[j]}' if j == k2 else f'{ys[j]}-{ys[k2]}',
                observed=' '.join(str(int(o)) for o in obs), expected=' '.join(str(int(round(x))) for x in e),
                detail='dip' if direction < 0 else 'spike',
            ))
            j = k2 + 1
    return _with_names(pd.DataFrame(rows), ents)


def unplaced_share(summary: pd.DataFrame, ents: pd.DataFrame) -> pd.DataFrame:
    """Roads with many crashes placed by name / SRI only (see module docstring)."""
    s = summary.groupby('entity')[['n', 'n_unplaced']].sum()
    s = s[(s['n'] >= UNPLACED_MIN_N) & (s['n_unplaced'] >= UNPLACED_MIN_SHARE * s['n'])]
    share = s['n_unplaced'] / s['n']
    out = pd.DataFrame({
        'kind': 'unplaced', 'score': (s['n_unplaced'] * share).round(1), 'entity': s.index,
        'observed': s['n_unplaced'].astype(int).astype(str), 'expected': s['n'].astype(int).astype(str),
        'detail': [f'{x:.0%} of crashes without a map point' for x in share],
    }).reset_index(drop=True)
    return _with_names(out, ents)


def pair_swings(by_entity: pd.DataFrame, node_ents: pd.DataFrame, ents: pd.DataFrame, members: pd.DataFrame | None = None) -> pd.DataFrame:
    """Road pairs whose per-year split of shared crashes swings (see module docstring). Shared
    crashes: a crash at an intersection node of both roads (`by_entity.node`), on either; and, for
    two members of one corridor, all their crashes."""
    at = by_entity.dropna(subset=['node'])[['entity', 'node', 'year']].astype({'node': 'int64', 'entity': 'int64'})
    ne = node_ents[['node', 'entity']].astype('int64')
    x = at.merge(ne.rename(columns={'entity': 'other'}), on='node')
    x = x[x['other'] != x['entity']]
    x = x.assign(a=np.minimum(x['entity'], x['other']), b=np.maximum(x['entity'], x['other']))
    x['on_a'] = (x['entity'] == x['a']).astype(int)
    parts = [x[['a', 'b', 'year', 'on_a']]]
    if members is not None and len(members):
        m = members[['entity', 'corridor']]
        pairs = m.merge(m, on='corridor', suffixes=('_1', '_2'))
        pairs = pairs[pairs['entity_1'] < pairs['entity_2']]
        c = by_entity[['entity', 'year']].astype({'entity': 'int64'})
        for a, b in zip(pairs['entity_1'], pairs['entity_2']):
            cc = c[c['entity'].isin([a, b])]
            parts.append(pd.DataFrame({'a': a, 'b': b, 'year': cc['year'].to_numpy(), 'on_a': (cc['entity'] == a).astype(int).to_numpy()}))
    x = pd.concat(parts, ignore_index=True)
    g = x.groupby(['a', 'b', 'year'])['on_a'].agg(['size', 'sum']).reset_index()
    tot = g.groupby(['a', 'b'])[['size', 'sum']].sum()
    tot = tot[tot['size'] >= SWING_MIN_N]
    rows = []
    for (a, b), t in tot.iterrows():
        gy = g[(g['a'] == a) & (g['b'] == b) & (g['size'] >= SWING_MIN_YEAR)]
        if len(gy) < 3:
            continue
        p = t['sum'] / t['size']
        share = gy['sum'] / gy['size']
        if share.max() - share.min() < SWING_MIN_RANGE:
            continue
        e = gy['size'] * p
        with np.errstate(divide='ignore', invalid='ignore'):
            chi = float(np.nansum((gy['sum'] - e) ** 2 / (e * (1 - p)))) if 0 < p < 1 else 0.0
        lo, hi = gy.loc[share.idxmin()], gy.loc[share.idxmax()]
        rows.append(dict(
            kind='pair_swing', score=round(chi, 1), entity=int(a), other=int(b),
            years=f'{int(lo["year"])} / {int(hi["year"])}',
            observed=f'{share.min():.0%} / {share.max():.0%}', expected=f'{p:.0%}',
            detail=f'share of {int(t["size"])} shared crashes on the first road, min / max year',
        ))
    out = _with_names(pd.DataFrame(rows), ents)
    if len(out):
        slug = ents.set_index('entity')['slug']
        out['other_slug'] = out['other'].map(slug)
    return out


def corridor_yoy(cor_summary: pd.DataFrame, corridors: pd.DataFrame, summary: pd.DataFrame, ents: pd.DataFrame) -> pd.DataFrame:
    """`yoy_breaks` on corridors (`road-corridor-summary`, `road-corridors`: `corridor, slug, name,
    cc`), scaled by the roads' county / state totals (`road-summary`, `road-entities`), as kind
    `corridor_yoy` with `corridor` (the corridor's id) and its `slug` / `name`."""
    c = corridors.rename(columns={'corridor': 'entity'})
    out = yoy_breaks(cor_summary.rename(columns={'corridor': 'entity'}), c, scale_summary=summary, scale_ents=ents)
    if not len(out):
        return out
    return out.assign(kind='corridor_yoy', corridor=out['entity']).drop(columns=['entity'])


def _years(y: str) -> tuple[int, int]:
    """A finding's `years` ("2011", "2011-2013", "2012 / 2010") → `(lo, hi)`."""
    v = [int(x) for x in y.replace('/', '-').split('-') if x.strip()]
    return min(v), max(v)


def absorbed(findings: pd.DataFrame, cor_breaks: pd.DataFrame, members: pd.DataFrame) -> np.ndarray:
    """Which `yoy` / `pair_swing` `findings` a corridor absorbs: the road (and, for a pair, the other
    road too) is in a corridor (`members`: `entity, corridor`) with no `corridor_yoy` finding
    (`cor_breaks`) overlapping the finding's years."""
    if not len(findings):
        return np.zeros(0, dtype=bool)
    c_of = members.dropna(subset=['corridor']).astype({'entity': 'int64', 'corridor': 'int64'}).set_index('entity')['corridor']
    br: dict[int, list[tuple[int, int]]] = {}
    for c, y in zip(cor_breaks.get('corridor', []), cor_breaks.get('years', [])):
        br.setdefault(int(c), []).append(_years(y))
    out = []
    for r in findings.itertuples():
        c = c_of.get(int(r.entity))
        other = getattr(r, 'other', None)
        if c is None or (other is not None and not pd.isna(other) and c_of.get(int(other)) != c):
            out.append(False)
            continue
        lo, hi = _years(r.years)
        out.append(not any(a <= hi and lo <= b for a, b in br.get(int(c), [])))
    return np.array(out, dtype=bool)


def noted(findings: pd.DataFrame, notes: pd.DataFrame) -> np.ndarray:
    """Which `yoy` `findings` a data note explains (`road-notes`: `entity, year_lo, year_hi`): one on
    the road whose years (all years, when it has none) overlap the finding's."""
    if not len(findings) or not len(notes):
        return np.zeros(len(findings), dtype=bool)
    n = notes.dropna(subset=['entity'])
    by: dict[int, list[tuple[int, int]]] = {}
    for e, lo, hi in zip(n['entity'], n['year_lo'], n['year_hi']):
        by.setdefault(int(e), []).append((-10**4 if pd.isna(lo) else int(lo), 10**4 if pd.isna(hi) else int(hi)))
    out = []
    for e, y in zip(findings['entity'], findings['years']):
        lo, hi = _years(y)
        out.append(any(a <= hi and lo <= b for a, b in by.get(int(e), [])))
    return np.array(out, dtype=bool)


def _with_names(df: pd.DataFrame, ents: pd.DataFrame) -> pd.DataFrame:
    if not len(df):
        return pd.DataFrame(columns=QUEUE_COLS)
    e = ents.set_index('entity')
    return df.assign(slug=df['entity'].map(e['slug']), name=df['entity'].map(e['name']))


def review_queue(parts: list[pd.DataFrame]) -> pd.DataFrame:
    """The findings, ranked within each kind by score, interleaved by rank (so one kind's scale
    doesn't bury another's): columns `QUEUE_COLS` + `rank` (within its kind)."""
    df = pd.concat([p for p in parts if len(p)], ignore_index=True) if any(len(p) for p in parts) else pd.DataFrame(columns=QUEUE_COLS)
    for c in QUEUE_COLS:
        if c not in df:
            df[c] = pd.NA
    df = df.sort_values(['kind', 'score'], ascending=[True, False], kind='stable')
    df['rank'] = df.groupby('kind').cumcount() + 1
    return df.sort_values(['rank', 'kind'], kind='stable').reset_index(drop=True)[['rank'] + QUEUE_COLS]


def queue_markdown(q: pd.DataFrame, top: int) -> str:
    """The top `top` findings of each kind as markdown tables."""
    out = ['# Road anomaly review queue', '']
    titles = {
        'yoy': 'Year-over-year breaks', 'corridor_yoy': 'Year-over-year breaks of corridors',
        'unplaced': 'Crashes without a map point', 'pair_swing': 'Attribution swings between road pairs',
    }
    for kind, title in titles.items():
        k = q[q['kind'] == kind].head(top)
        out += [f'## {title} (`{kind}`)', '']
        if not len(k):
            out += ['None.', '']
            continue
        out += ['| # | score | road | other | years | observed | expected | detail |', '|---:|---:|---|---|---|---|---|---|']
        for r in k.itertuples():
            other = '' if pd.isna(r.other_slug) else f'`{r.other_slug}`'
            out.append(f'| {r.rank} | {r.score} | `{r.slug}` ({r.name}) | {other} | {r.years if not pd.isna(r.years) else ""} | {r.observed} | {r.expected} | {r.detail} |')
        out.append('')
    return '\n'.join(out)
