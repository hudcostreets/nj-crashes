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
`GAP_RATIO` of its neighboring years' (scaled by the rest of its county's trend) is, in every case
checked, its police department's reports missing from NJDOT's data (Edgewater May 2010–2012, Deptford
2013–14, Bridgeton 2018–20, Pleasantville 2020–23, Boonton 2021–23). Each gap becomes a `coverage`
note (id `gap-<cc>-<mc>-<years>`) on the roads through that muni, unless a curated note already
covers that muni and those years.
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
# `muni_gaps`: munis with a median of ≥ `GAP_MIN_MEDIAN` crashes a year; a year is a gap when its total
# is < `GAP_RATIO` × the median of up to `GAP_WINDOW` years on each side (≥ `GAP_MIN_NEIGHBORS` of them),
# scaled by the rest of the county's totals.
GAP_MIN_MEDIAN = 100
GAP_RATIO = 0.5
GAP_WINDOW = 3
GAP_MIN_NEIGHBORS = 4


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


def muni_gaps(counts: pd.DataFrame) -> pd.DataFrame:
    """Coverage gaps in `counts` (`cc, mc, year, n`: crashes per muni-year): runs of consecutive
    years whose total is < `GAP_RATIO` of the expected (see the module docstring). Rows `cc, mc,
    year_lo, year_hi, observed` (the years' totals, space-joined), `expected` (likewise)."""
    c = counts.groupby(['cc', 'mc', 'year'])['n'].sum().reset_index()
    ys = np.arange(int(c['year'].min()), int(c['year'].max()) + 1) if len(c) else np.array([], dtype=int)
    grid = c.pivot_table(index=['cc', 'mc'], columns='year', values='n', aggfunc='sum').reindex(columns=ys).fillna(0)
    county = grid.groupby(level='cc').sum()
    rows = []
    for (cc, mc), v in zip(grid.index, grid.to_numpy()):
        if np.median(v) < GAP_MIN_MEDIAN:
            continue
        rest = county.loc[cc].to_numpy(dtype=float) - v
        exp = np.full(len(ys), np.nan)
        gap = np.zeros(len(ys), dtype=bool)
        for j in range(len(ys)):
            nb = [i for i in range(max(0, j - GAP_WINDOW), min(len(ys), j + GAP_WINDOW + 1)) if i != j and rest[i] > 0]
            if len(nb) < GAP_MIN_NEIGHBORS or rest[j] <= 0:
                continue
            exp[j] = float(np.median([v[i] * rest[j] / rest[i] for i in nb]))
            gap[j] = v[j] < GAP_RATIO * exp[j]
        j = 0
        while j < len(ys):
            if not gap[j]:
                j += 1
                continue
            k = j
            while k + 1 < len(ys) and gap[k + 1]:
                k += 1
            rows.append(dict(
                cc=int(cc), mc=int(mc), year_lo=int(ys[j]), year_hi=int(ys[k]),
                observed=' '.join(str(int(x)) for x in v[j:k + 1]), expected=' '.join(str(int(round(x))) for x in exp[j:k + 1]),
            ))
            j = k + 1
    return pd.DataFrame(rows, columns=['cc', 'mc', 'year_lo', 'year_hi', 'observed', 'expected'])


def gap_notes(gaps: pd.DataFrame, notes: list[Note], muni_name: dict[tuple[int, int], str] | None = None) -> list[Note]:
    """`muni_gaps` rows → `coverage` notes, skipping a gap whose muni and years a curated `notes`
    entry (with scalar `cc` / `mc`) already covers."""
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
        obs, exp = g.observed.split(), g.expected.split()
        pairs = ', '.join(f'{o} ({y})' for o, y in zip(obs, range(g.year_lo, g.year_hi + 1)))
        exp_lo, exp_hi = min(map(int, exp)), max(map(int, exp))
        exp_s = f'~{exp_lo:,}' if exp_lo == exp_hi else f'~{exp_lo:,}–{exp_hi:,}'
        out.append(Note(
            id=f'gap-{g.cc}-{g.mc}-{g.year_lo}' + ('' if g.year_lo == g.year_hi else f'-{g.year_hi}'),
            kind='coverage', years=(g.year_lo, g.year_hi),
            title=f'Most of {name}\'s crash reports are missing for {yrs}',
            text=(
                f'NJDOT\'s data has {pairs} crashes in {name}, vs {exp_s} a year expected from the years '
                f'around them (and the rest of the county\'s trend): most of the town\'s crash reports for '
                f'{yrs} are missing from the data, so its roads\' counts for {yrs} are too low.'
            ),
            where={'cc': g.cc, 'mc': g.mc, 'subt': LOCAL_SUBT},
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
