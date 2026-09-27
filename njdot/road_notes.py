"""Per-road data notes (`njdot/data/road_notes.yml` → `road-notes.parquet`; specs/road-anomalies.md §
Data notes): short, curated explanations of known changes in how NJDOT's data covers or codes a road
("Jersey City PD has reported ~30% fewer property-damage crashes since 2020", "Port Authority police
crashes are in the data only from 2019"), for road / corridor pages to show beside the per-year
counts they explain.

Each note selects roads by `where` (all conditions must hold):

- `cc`, `mc`: a county / muni the road runs through (a scalar or a list; with `ent_munis`, else the
  road's own `road-entities.cc` / `mc`).
- `slug`, `name`: case-insensitive regexes, full match, on the road's slug / name.
- `sris`: a case-insensitive regex *searched* in the road's comma-joined SRIs.
- `bbox`: `[w, s, e, n]` (degrees): the road's bbox center is inside.
- `subt`: the road's class (`road-entities.subt`; a scalar or a list). Muni-wide notes about a police
  department take `LOCAL_SUBT`: the State Police patrol interstates and toll roads (and ramps are
  theirs), so a town's reporting doesn't reach them.

With `corridors: true` a note also applies to the corridors of the roads it selects, and to every
member road of those corridors. The build writes one row per (road, note) and per (corridor, note).

**Coverage gaps** (`muni_gaps`) are noted automatically: a muni-year whose crash total is under
`GAP_RATIO` of its other years' (scaled by the rest of its county's trend) is, in every case checked,
its police department's reports missing from NJDOT's data (Edgewater May 2010–2012, Deptford
2013–14, Bridgeton 2018–20, Pleasantville 2020–23, Boonton 2021–23). A partial gap (under
`GAP_PARTIAL_RATIO`, beyond the town's own year-to-year spread) is too when some of its months are
near-empty (Hoboken 2023–25: Feb 2023 has 5 crashes, Oct 2024 2); without that it may be a change in
reporting. Each gap becomes a note (id `gap-<cc>-<mc>-<years>`; `coverage`, or `unexplained` for an
uncorroborated partial gap: `gap_notes`) on the roads through that muni, unless a curated note
already covers that muni and those years.
"""
import re
from dataclasses import dataclass
from os.path import exists

import numpy as np
import pandas as pd
import yaml

from njdot.paths import DOT_DATA

ROAD_NOTES = f'{DOT_DATA}/road_notes.yml'
NOTE_KINDS = ('reporting', 'coverage', 'coding', 'unexplained')
NOTE_WHERE_KEYS = ('cc', 'mc', 'slug', 'name', 'sris', 'bbox', 'subt')
# Road classes a municipal police department reports on: not interstates (1), toll roads (4), ramps (8).
LOCAL_SUBT = [2, 3, 5, 6, 7]
NOTE_COLS = ['entity', 'corridor', 'note', 'kind', 'year_lo', 'year_hi', 'title', 'text']
# `muni_gaps`: munis with a median of ≥ `GAP_MIN_MEDIAN` crashes a year. A year's expected total is the
# median of its `GAP_NEIGHBORS` nearest other non-gap years (≥ `GAP_MIN_NEIGHBORS` of them, at most
# `GAP_MAX_DIST` years away), each scaled by the rest of the county's totals. A year is a gap when its
# total is < `GAP_RATIO` × expected, or (a partial gap) < `GAP_PARTIAL_RATIO` × expected, short by ≥
# `GAP_MIN_SHORTFALL` crashes and by more than `GAP_Z` × the muni's own year-to-year spread (robust:
# 1.4826 × the MAD of its other years' log(observed / expected), at least `GAP_MIN_SPREAD`). Gap years
# don't count toward other years' expectations (iterated, ≤ `GAP_ITERS` times).
GAP_MIN_MEDIAN = 100
GAP_RATIO = 0.5
GAP_PARTIAL_RATIO = 0.75
GAP_MIN_SHORTFALL = 100
GAP_Z = 3.0
GAP_MIN_SPREAD = 0.05
GAP_NEIGHBORS = 6
GAP_MIN_NEIGHBORS = 4
GAP_MAX_DIST = 8
GAP_ITERS = 5
# A month (of a gap year) with under this share of the year's expected monthly count is "near-empty":
# a batch of reports missing, which a real change in crashes doesn't look like.
GAP_EMPTY_MONTH = 0.25
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

@dataclass
class Note:
    id: str
    kind: str
    title: str
    text: str
    where: dict
    years: tuple[int, int] | None = None
    corridors: bool = False


def load_notes(path: str = ROAD_NOTES) -> list[Note]:
    """The notes in `path` (none if it doesn't exist). Raises on a duplicate id, an unknown `kind` or
    `where` key, an empty `where`, or a missing `title` / `text`."""
    if not exists(path):
        return []
    with open(path) as f:
        raw = yaml.safe_load(f) or []
    out, seen = [], set()
    for r in raw:
        nid = r['id']
        if nid in seen:
            raise ValueError(f'{path}: duplicate note id {nid!r}')
        seen.add(nid)
        if r.get('kind') not in NOTE_KINDS:
            raise ValueError(f'{path}: note {nid!r}: `kind` must be one of {list(NOTE_KINDS)}')
        for k in ('title', 'text'):
            if not str(r.get(k) or '').strip():
                raise ValueError(f'{path}: note {nid!r} has no `{k}`')
        where = r.get('where') or {}
        bad = set(where) - set(NOTE_WHERE_KEYS)
        if bad:
            raise ValueError(f'{path}: note {nid!r}: unknown `where` keys {sorted(bad)}')
        if not where:
            raise ValueError(f'{path}: note {nid!r} has an empty `where`')
        ys = r.get('years')
        years = None if ys is None else (int(ys), int(ys)) if not isinstance(ys, (list, tuple)) else (int(ys[0]), int(ys[-1]))
        out.append(Note(
            id=nid, kind=r['kind'], title=' '.join(str(r['title']).split()), text=' '.join(str(r['text']).split()),
            where=where, years=years, corridors=bool(r.get('corridors', False)),
        ))
    return out


def _values(v) -> list:
    return list(v) if isinstance(v, (list, tuple)) else [v]


def note_mask(ents: pd.DataFrame, where: dict, ent_munis: pd.DataFrame | None = None) -> np.ndarray:
    """Which `ents` (`road-entities` columns `entity, slug, name, cc, mc, sris, lon_min … lat_max`) a
    note's `where` selects; `cc` / `mc` match any `(entity, cc, mc)` row of `ent_munis` when given."""
    m = np.ones(len(ents), dtype=bool)
    if ent_munis is not None and ('cc' in where or 'mc' in where):
        em = ent_munis
        if 'cc' in where:
            em = em[em['cc'].isin(_values(where['cc']))]
        if 'mc' in where:
            em = em[em['mc'].isin(_values(where['mc']))]
        m &= ents['entity'].isin(set(em['entity'])).to_numpy(dtype=bool)
    for k, v in where.items():
        if k in ('cc', 'mc'):
            if ent_munis is None:
                m &= ents[k].isin(_values(v)).fillna(False).to_numpy(dtype=bool)
        elif k in ('slug', 'name'):
            rx = re.compile(str(v), re.IGNORECASE)
            m &= np.array([bool(rx.fullmatch(str(s))) for s in ents[k].fillna('')], dtype=bool)
        elif k == 'sris':
            rx = re.compile(str(v), re.IGNORECASE)
            m &= np.array([bool(rx.search(str(s))) for s in ents['sris'].fillna('')], dtype=bool)
        elif k == 'subt':
            m &= ents['subt'].isin(_values(v)).fillna(False).to_numpy(dtype=bool)
        elif k == 'bbox':
            w, s, e, n = v
            lon = (ents['lon_min'] + ents['lon_max']).to_numpy(dtype='float64') / 2
            lat = (ents['lat_min'] + ents['lat_max']).to_numpy(dtype='float64') / 2
            m &= (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)
    return m


GAP_COLS = ['cc', 'mc', 'year_lo', 'year_hi', 'observed', 'expected', 'spread', 'empty_months']


def _gap_years(v: np.ndarray, rest: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """One muni's yearly totals `v` and the rest of its county's `rest` → `(gap, expected, spread)`
    per `muni_gaps`' rules."""
    n = len(v)
    gap = np.zeros(n, dtype=bool)
    exp = np.full(n, np.nan)
    spread = GAP_MIN_SPREAD
    for _ in range(GAP_ITERS):
        exp = np.full(n, np.nan)
        for j in range(n):
            if rest[j] <= 0:
                continue
            nb = sorted(
                (i for i in range(n) if i != j and not gap[i] and rest[i] > 0 and abs(i - j) <= GAP_MAX_DIST),
                key=lambda i: (abs(i - j), i),
            )[:GAP_NEIGHBORS]
            if len(nb) >= GAP_MIN_NEIGHBORS:
                exp[j] = float(np.median([v[i] * rest[j] / rest[i] for i in nb]))
        ok = np.isfinite(exp)
        r = np.log((v + 1) / (np.where(ok, exp, 0) + 1))
        base = ok & ~gap
        if base.sum() >= GAP_MIN_NEIGHBORS:
            rb = r[base]
            spread = max(1.4826 * float(np.median(np.abs(rb - np.median(rb)))), GAP_MIN_SPREAD)
        with np.errstate(invalid='ignore'):
            most = ok & (v < GAP_RATIO * exp)
            partial = ok & (v < GAP_PARTIAL_RATIO * exp) & (exp - v >= GAP_MIN_SHORTFALL) & (r < -GAP_Z * spread)
        new = most | partial
        if (new == gap).all():
            break
        gap = new
    return gap, exp, spread


def muni_gaps(counts: pd.DataFrame) -> pd.DataFrame:
    """Coverage gaps in `counts` (`cc, mc, year, n`: crashes per muni-year, or per muni-year-`month`):
    runs of consecutive years whose total is well under the expected (see `GAP_*` above). Rows
    `GAP_COLS`: `observed` / `expected` (the years' totals, space-joined), `spread` (the muni's
    year-to-year spread, a log ratio), `empty_months` (with `month`: the gap years' near-empty
    months, `GAP_EMPTY_MONTH`, as space-joined "YYYY-MM:n"; else empty)."""
    by_month = 'month' in counts
    c = counts.groupby(['cc', 'mc', 'year'])['n'].sum().reset_index()
    ys = np.arange(int(c['year'].min()), int(c['year'].max()) + 1) if len(c) else np.array([], dtype=int)
    grid = c.pivot_table(index=['cc', 'mc'], columns='year', values='n', aggfunc='sum').reindex(columns=ys).fillna(0)
    county = grid.groupby(level='cc').sum()
    months = counts.groupby(['cc', 'mc', 'year', 'month'])['n'].sum() if by_month else None
    rows = []
    for (cc, mc), v in zip(grid.index, grid.to_numpy()):
        if np.median(v) < GAP_MIN_MEDIAN:
            continue
        rest = county.loc[cc].to_numpy(dtype=float) - v
        gap, exp, spread = _gap_years(v, rest)
        j = 0
        while j < len(ys):
            if not gap[j]:
                j += 1
                continue
            k = j
            while k + 1 < len(ys) and gap[k + 1]:
                k += 1
            empty = []
            if by_month:
                for t in range(j, k + 1):
                    for mo in range(1, 13):
                        nm = int(months.get((cc, mc, int(ys[t]), mo), 0))
                        if nm < GAP_EMPTY_MONTH * exp[t] / 12:
                            empty.append(f'{ys[t]}-{mo:02d}:{nm}')
            rows.append(dict(
                cc=int(cc), mc=int(mc), year_lo=int(ys[j]), year_hi=int(ys[k]),
                observed=' '.join(str(int(x)) for x in v[j:k + 1]), expected=' '.join(str(int(round(x))) for x in exp[j:k + 1]),
                spread=round(spread, 3), empty_months=' '.join(empty),
            ))
            j = k + 1
    return pd.DataFrame(rows, columns=GAP_COLS)


def missing_share(missing: float) -> str:
    """A missing share (0–1) in words, for a note: "nearly all" … "about a quarter"."""
    return (
        'nearly all' if missing >= 0.9 else 'most' if missing >= 0.6 else 'about half' if missing >= 0.4
        else 'about a third' if missing >= 0.3 else 'about a quarter'
    )


def gap_notes(gaps: pd.DataFrame, notes: list[Note], muni_name: dict[tuple[int, int], str] | None = None) -> list[Note]:
    """`muni_gaps` rows → notes, skipping a gap whose muni and years a curated `notes` entry (with
    scalar `cc` / `mc`) already covers.

    A gap under `GAP_RATIO` of the expected, or with near-empty months (`empty_months`: a batch of
    reports absent), is reports missing from NJDOT's data: a `coverage` note saying how much
    (`missing_share` of the run's observed / expected: "About half of Hoboken's crash reports are
    missing for 2023–2025"). A partial gap without either is a shortfall beyond the town's usual
    year-to-year spread, but could be its police reporting fewer crashes (or fewer crashes): an
    `unexplained` note ("Clifton has ~30% fewer crash reports than expected for 2020")."""
    covered = [
        (n.where['cc'], n.where['mc'], n.years) for n in notes
        if not isinstance(n.where.get('cc'), (list, tuple, type(None))) and not isinstance(n.where.get('mc'), (list, tuple, type(None)))
    ]
    out = []
    for g in gaps.itertuples():
        if any(c == g.cc and m == g.mc and (ys is None or (ys[0] <= g.year_hi and g.year_lo <= ys[1])) for c, m, ys in covered):
            continue
        name = (muni_name or {}).get((g.cc, g.mc), f'muni {g.cc}-{g.mc}')
        yrs = f'{g.year_lo}' if g.year_lo == g.year_hi else f'{g.year_lo}–{g.year_hi}'
        obs, exp = [int(x) for x in g.observed.split()], [int(x) for x in g.expected.split()]
        missing = 1 - sum(obs) / max(sum(exp), 1)
        pct = f'~{5 * round(20 * missing):d}%'
        pairs = ', '.join(f'{o:,} ({y})' for o, y in zip(obs, range(g.year_lo, g.year_hi + 1)))
        exp_s = f'~{min(exp):,}' if min(exp) == max(exp) else f'~{min(exp):,}–{max(exp):,}'
        counts = (
            f'NJDOT\'s data has {pairs} crashes in {name}, vs {exp_s} a year expected from the town\'s other '
            f'years (and the rest of the county\'s trend)'
        )
        empty = [e.split(':') for e in str(getattr(g, 'empty_months', '') or '').split()]
        nid = f'gap-{g.cc}-{g.mc}-{g.year_lo}' + ('' if g.year_lo == g.year_hi else f'-{g.year_hi}')
        where = {'cc': g.cc, 'mc': g.mc, 'subt': LOCAL_SUBT}
        if empty or missing >= 1 - GAP_RATIO:
            share = missing_share(missing)
            evidence = ''
            if empty:
                ms = ', '.join(f'{MONTHS[int(ym[5:]) - 1]} {ym[:4]}: {int(n)}' for ym, n in empty[:4]) + (', …' if len(empty) > 4 else '')
                evidence = f', and {len(empty)} of its months have almost none ({ms})'
            out.append(Note(
                id=nid, kind='coverage', years=(g.year_lo, g.year_hi),
                title=f'{share[0].upper()}{share[1:]} of {name}\'s crash reports are missing for {yrs}',
                text=(
                    f'{counts}{evidence}: {share} ({pct}) of the town\'s crash reports for {yrs} are missing from the '
                    f'data, so its roads\' counts for {yrs} are too low.'
                ),
                where=where,
            ))
        else:
            spread = round(100 * (np.exp(g.spread) - 1))
            out.append(Note(
                id=nid, kind='unexplained', years=(g.year_lo, g.year_hi),
                title=f'{name} has {pct} fewer crash reports than expected for {yrs}',
                text=(
                    f'{counts}: {pct} fewer, where its totals otherwise vary by about ±{spread:d}% a year. Reports '
                    f'missing from the data, its police reporting fewer crashes, or fewer crashes: the data can\'t tell '
                    f'which, so compare its roads\' counts for {yrs} with care.'
                ),
                where=where,
            ))
    return out


def road_notes(
    notes: list[Note],
    ents: pd.DataFrame,
    corridor_of: pd.Series | None = None,
    ent_munis: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """`road-notes`: one row per (road, note) and per (corridor, note) (`NOTE_COLS`; `entity` null
    on corridor rows, `corridor` null on road rows), sorted `(entity, corridor, note)` with nulls
    last. `corridor_of`: each entity's corridor (entities in none absent / NA); `ent_munis`: the
    `(entity, cc, mc)` munis each road runs through (`note_mask`)."""
    corridor_of = pd.Series(dtype='Int32') if corridor_of is None else corridor_of.dropna().astype('int64')
    rows = []
    for nt in notes:
        sel = set(ents['entity'].to_numpy()[note_mask(ents, nt.where, ent_munis)].astype('int64').tolist())
        cors: set[int] = set()
        if nt.corridors:
            cors = {int(corridor_of[e]) for e in sel if e in corridor_of.index}
            sel |= {int(e) for e, c in corridor_of.items() if int(c) in cors}
        lo, hi = nt.years if nt.years else (None, None)
        base = dict(note=nt.id, kind=nt.kind, year_lo=lo, year_hi=hi, title=nt.title, text=nt.text)
        rows += [dict(entity=e, corridor=None, **base) for e in sorted(sel)]
        rows += [dict(entity=None, corridor=c, **base) for c in sorted(cors)]
    df = pd.DataFrame(rows, columns=NOTE_COLS)
    df = df.astype({
        'entity': 'Int32', 'corridor': 'Int32', 'note': 'string', 'kind': 'string', 'year_lo': 'Int16', 'year_hi': 'Int16',
        'title': 'string', 'text': 'string',
    })
    return df.sort_values(['entity', 'corridor', 'note'], na_position='last', kind='stable').reset_index(drop=True)
