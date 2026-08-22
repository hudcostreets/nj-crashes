"""`njdot tune ...` — analyze the `/tune/ab` preference corpus and fit picker config.

The `/tune/ab` page (`www/src/routes/TuneAbPage.tsx`) streams side-by-side
S2-level comparisons and records a preference per pair into the `tune` D1
(`picker_votes`, served at `$CELLS_API/v1/tune/votes`). This module is the
offline half of that loop, per `specs/tune-preference-learning.md`: read the
corpus, summarize directional pressure, and grid-search `tuning.json`
candidates against the recorded preferences.

Single source of truth for the picker math is the frontend: the S2 diameter
table is parsed out of `www/src/map/s2/index.ts` and the shipped config out of
`www/src/map/tuning.json`, so a change there can't silently desync this fit.
"""
import json
import re
from dataclasses import dataclass
from math import sqrt
from pathlib import Path
from typing import Iterable
from urllib.request import Request, urlopen

from utz.cli import arg, flag, opt

from nj_crashes.utils.log import err
from njdot.cli.base import njdot

WWW = Path(__file__).parent.parent.parent / 'www'
S2_TS = WWW / 'src' / 'map' / 's2' / 'index.ts'
TUNING_JSON = WWW / 'src' / 'map' / 'tuning.json'
CELLS_API = 'https://crashes-cells-api.ryan-0dc.workers.dev'
VOTES_URL = f'{CELLS_API}/v1/tune/votes'

# `pickS2LevelForPixels` clamps to the diameter table; the client clamps the
# result to this envelope (the levels the pyramid actually builds).
S2_MIN_LEVEL = 4
S2_MAX_LEVEL = 21


def s2_diameters() -> dict[int, float]:
    """Parse `S2_DIAMETER_METERS` out of the TS module (no Python copy to drift)."""
    src = S2_TS.read_text()
    m = re.search(r'S2_DIAMETER_METERS: Record<number, number> = \{(.*?)\n\}', src, re.S)
    if not m:
        raise ValueError(f"{S2_TS}: couldn't locate S2_DIAMETER_METERS literal")
    out = {}
    for level, meters in re.findall(r'(\d+):\s*([\d_.]+)', m.group(1)):
        out[int(level)] = float(meters.replace('_', ''))
    if not out:
        raise ValueError(f"{S2_TS}: S2_DIAMETER_METERS parsed empty")
    return out


DIAMETERS = s2_diameters()


def bins_budget() -> int:
    """Parse `BINS_BUDGET` out of `picker.ts` (same no-drift rule as the diameters)."""
    src = (WWW / 'src' / 'map' / 'picker.ts').read_text()
    m = re.search(r'export const BINS_BUDGET = (\d+)', src)
    if not m:
        raise ValueError("picker.ts: couldn't locate BINS_BUDGET")
    return int(m.group(1))


BINS_BUDGET = bins_budget()
# `autoHexPxTarget`'s upper clamp; nothing in the corpus comes near it.
MAX_TARGET_PX = 30.0


@dataclass(frozen=True)
class Cfg:
    """A candidate `tuning.json` `s2` block.

    Two knobs act on disjoint regimes, which is what makes them separately
    fittable: `minTargetPx` is `autoHexPxTarget`'s lower clamp, and it *binds*
    for every county/muni-scoped view (their budgeted `areaPx` is small enough
    that `√(areaPx/budget)` lands under 1 px), while statewide/street views run
    above the clamp and see only `targetFactor`.
    """
    target_factor: float
    min_target_px: float
    pick_mult: tuple[tuple[int, float], ...]

    @staticmethod
    def shipped() -> 'Cfg':
        s2 = json.loads(TUNING_JSON.read_text())['s2']
        return Cfg(
            s2['targetFactor'],
            s2.get('minTargetPx', 1.0),
            tuple(sorted((int(k), v) for k, v in s2['pickMult'].items())),
        )

    @property
    def mult(self) -> dict[int, float]:
        return dict(self.pick_mult)

    def __str__(self) -> str:
        mults = ', '.join(f'{lvl}:{m:g}' for lvl, m in self.pick_mult)
        return f'targetFactor={self.target_factor:g} minTargetPx={self.min_target_px:g} pickMult={{{mults}}}'

    def target_px(self, area_px: float) -> float:
        """Port of `autoHexPxTarget` (with `minTargetPx` as the lower clamp)."""
        return min(MAX_TARGET_PX, max(self.min_target_px, sqrt(area_px / max(1, BINS_BUDGET))))

    def pick(self, area_px: float, mppx: float) -> int:
        """Port of `pickS2LevelForPixels` — finest level still ≥ the px target."""
        target_meters = self.target_px(area_px) * self.target_factor * mppx
        mult = self.mult
        best = min(DIAMETERS)
        for lvl in sorted(DIAMETERS):
            if DIAMETERS[lvl] * mult.get(lvl, 1.0) >= target_meters:
                best = lvl
            else:
                break
        return max(S2_MIN_LEVEL, min(S2_MAX_LEVEL, best))


@dataclass(frozen=True)
class Vote:
    """One `picker_votes` row, reduced to what the fit conditions on."""
    id: int
    view: str
    zoom: float
    mppx: float
    area_px: float
    auto_target_px: float
    prod: int
    left: int
    right: int
    left_bins: int | None
    right_bins: int | None
    choice: str
    chosen: int | None
    note: str

    @staticmethod
    def of(row: dict) -> 'Vote':
        return Vote(
            id=row['id'], view=row['view'], zoom=row['zoom'], mppx=row['mppx'],
            area_px=row['areaPx'], auto_target_px=row['autoTargetPx'], prod=row['prod'],
            left=row['left']['level'], right=row['right']['level'],
            left_bins=row['left']['bins'], right_bins=row['right']['bins'],
            choice=row['choice'], chosen=row['chosen'], note=row.get('note') or '',
        )

    @property
    def lo(self) -> int:
        return min(self.left, self.right)

    @property
    def hi(self) -> int:
        return max(self.left, self.right)

    def satisfied_by(self, level: int) -> bool:
        """Would picking `level` have honored this vote?

        Higher S2 level = smaller cell, so "want finer than both shown" means a
        level above the pair, "coarser" a level below it. A tie accepts either
        shown level (the voter said the boundary doesn't matter there).
        """
        if self.choice in ('left', 'right'):
            return level == self.chosen
        if self.choice == 'tie':
            return level in (self.left, self.right)
        if self.choice == 'finer':
            return level > self.hi
        if self.choice == 'coarser':
            return level < self.lo
        raise ValueError(f'vote {self.id}: unknown choice {self.choice!r}')

    def pressure(self) -> int:
        """Signed direction the vote pushes prod: +1 finer, -1 coarser, 0 none."""
        if self.choice == 'tie':
            return 0
        if self.choice == 'finer':
            return 1
        if self.choice == 'coarser':
            return -1
        assert self.chosen is not None
        return (self.chosen > self.prod) - (self.chosen < self.prod)

    def bins(self, level: int) -> int | None:
        if level == self.left:
            return self.left_bins
        if level == self.right:
            return self.right_bins
        return None


def load_votes(url: str, limit: int, cache: Path | None) -> list[Vote]:
    if cache and cache.exists():
        body = cache.read_text()
    else:
        req = Request(f'{url}?limit={limit}', headers={'User-Agent': 'njdot-tune/1.0'})
        with urlopen(req) as r:
            body = r.read().decode()
        if cache:
            cache.write_text(body)
    return [Vote.of(row) for row in json.loads(body)['votes']]


def candidates(base: Cfg, levels: list[int]) -> Iterable[Cfg]:
    """Grid over `targetFactor` × per-level `pickMult` for the levels in play."""
    factors = [round(0.30 + 0.05 * i, 2) for i in range(31)]   # 0.30 .. 1.80
    floors = [round(0.50 + 0.10 * i, 2) for i in range(26)]    # 0.50 .. 3.00
    mults = [round(0.20 + 0.05 * i, 2) for i in range(25)]     # 0.20 .. 1.40
    base_mult = base.mult
    for f in factors:
        for floor in floors:
            yield Cfg(f, floor, base.pick_mult)
            for lvl in levels:
                for m in mults:
                    if m == base_mult.get(lvl, 1.0):
                        continue
                    yield Cfg(f, floor, tuple(sorted({**base_mult, lvl: m}.items())))


@njdot.group('tune')
def tune():
    """Analyze the `/tune/ab` picker-preference corpus."""


def _load(url, limit, cache):
    votes = load_votes(url, limit, Path(cache) if cache else None)
    err(f'{len(votes)} votes')
    return votes


url_opt = opt('-u', '--url', default=VOTES_URL, help='Votes endpoint')
limit_opt = opt('-n', '--limit', type=int, default=5000, help='Max votes to fetch')
cache_opt = opt('-c', '--cache', help='Read/write the raw JSON response here instead of refetching')


@tune.command('votes')
@cache_opt
@limit_opt
@url_opt
def votes_cmd(cache, limit, url):
    """Summarize the corpus: per-view outcomes and directional pressure."""
    votes = _load(url, limit, cache)
    by_view: dict[str, list[Vote]] = {}
    for v in votes:
        by_view.setdefault(v.view, []).append(v)
    print(f'{"view":<24} {"n":>3} {"prod":>5} {"alt":>4} {"tie":>4} {"finer":>6} {"coarser":>8} {"pressure":>9} {"bins(chosen)":>13}')
    for view, vs in sorted(by_view.items(), key=lambda kv: -len(kv[1])):
        prod = sum(1 for v in vs if v.chosen == v.prod)
        alt = sum(1 for v in vs if v.chosen is not None and v.chosen != v.prod)
        tie = sum(1 for v in vs if v.choice == 'tie')
        finer = sum(1 for v in vs if v.choice == 'finer')
        coarser = sum(1 for v in vs if v.choice == 'coarser')
        press = sum(v.pressure() for v in vs)
        chosen_bins = [b for v in vs if v.chosen is not None for b in [v.bins(v.chosen)] if b]
        med = sorted(chosen_bins)[len(chosen_bins) // 2] if chosen_bins else 0
        print(f'{view:<24} {len(vs):>3} {prod:>5} {alt:>4} {tie:>4} {finer:>6} {coarser:>8} {press:>+9} {med:>13,}')
    press = sum(v.pressure() for v in votes)
    decisive = [v for v in votes if v.pressure()]
    agree = sum(1 for v in decisive if v.pressure() > 0)
    print(f'\noverall pressure {press:+d} over {len(decisive)} decisive votes '
          f'({100 * agree / len(decisive):.0f}% want finer)' if decisive else '\nno decisive votes')


@tune.command('fit')
@opt('-k', '--top', type=int, default=8, help='How many candidate configs to print')
@cache_opt
@limit_opt
@flag('-m', '--misses', help='List the votes the best config violates')
@url_opt
def fit_cmd(top, cache, limit, misses, url):
    """Grid-search `tuning.json` candidates against the corpus."""
    votes = _load(url, limit, cache)
    if not votes:
        return
    base = Cfg.shipped()
    levels = sorted({lvl for v in votes for lvl in (v.left, v.right, v.prod)})

    # Prefer configs that leave `pickMult` alone: a per-level multiplier fit to
    # a handful of votes at one boundary is the easiest way to overfit a small
    # corpus. Then prefer the smallest move from the shipped scalars.
    def complexity(cfg: Cfg) -> tuple[int, float]:
        base_mult = base.mult
        keys = set(base_mult) | set(cfg.mult)
        deviations = sum(1 for k in keys if base_mult.get(k, 1.0) != cfg.mult.get(k, 1.0))
        return deviations, (abs(cfg.target_factor - base.target_factor)
                            + abs(cfg.min_target_px - base.min_target_px))

    # Collapse configs that are indistinguishable *on this corpus* — most of
    # the `pickMult` grid predicts identically because no vote sits at that
    # level's boundary. Keeping one representative per prediction vector stops
    # the top-k from being one config wearing 20 hats.
    by_prediction: dict[tuple[int, ...], tuple[int, Cfg]] = {}
    for cfg in candidates(base, levels):
        preds = tuple(cfg.pick(v.area_px, v.mppx) for v in votes)
        n = sum(1 for v, p in zip(votes, preds) if v.satisfied_by(p))
        prev = by_prediction.get(preds)
        if prev is None or complexity(cfg) < complexity(prev[1]):
            by_prediction[preds] = (n, cfg)
    scored = sorted(by_prediction.values(), key=lambda t: (-t[0], complexity(t[1])))
    base_n = sum(1 for v in votes if v.satisfied_by(base.pick(v.area_px, v.mppx)))
    print(f'shipped: {base_n}/{len(votes)} ({100 * base_n / len(votes):.0f}%)  {base}\n')
    print(f'{"score":>12}  config')
    for n, cfg in scored[:top]:
        print(f'{n:>4}/{len(votes)} {100 * n / len(votes):>4.0f}%  {cfg}')
    if misses:
        best = scored[0][1]
        print(f'\nviolated by {best}:')
        for v in votes:
            got = best.pick(v.area_px, v.mppx)
            if not v.satisfied_by(got):
                print(f'  #{v.id:<3} {v.view:<24} z={v.zoom:<6.2f} pair l{v.lo}/l{v.hi} '
                      f'choice={v.choice:<8} chosen={v.chosen} → picked l{got}  {v.note}')


@tune.command('levels')
@arg('view', required=False)
@cache_opt
@limit_opt
@url_opt
def levels_cmd(view, cache, limit, url):
    """Per-vote table: what the shipped config picks vs what was preferred."""
    votes = _load(url, limit, cache)
    base = Cfg.shipped()
    print(f'{"id":>3} {"view":<24} {"zoom":>6} {"mppx":>8} {"tgtPx":>6} {"prod":>4} {"pick":>4} '
          f'{"pair":>7} {"choice":<8} {"want":>5}  note')
    for v in votes:
        if view and view not in v.view:
            continue
        got = base.pick(v.area_px, v.mppx)
        want = str(v.chosen) if v.chosen is not None else {'tie': '~', 'finer': f'>{v.hi}', 'coarser': f'<{v.lo}'}[v.choice]
        print(f'{v.id:>3} {v.view:<24} {v.zoom:>6.2f} {v.mppx:>8.2f} {v.auto_target_px:>6.2f} '
              f'{v.prod:>4} {got:>4} {f"{v.lo}/{v.hi}":>7} {v.choice:<8} {want:>5}  {v.note}')


# ---------------------------------------------------------------------------
# Deck generation
#
# The `/tune/ab` sampler needs a *wide* deck: with 8 hand-written views the
# stream repeats itself within a session (Ryan: "many of the cases seemed
# repetitive"), and a corpus that only covers Hudson/Cape May/JC/Hoboken can't
# say anything about the rest of the state. These are derived from the muni
# boundary file the site already ships, so centers/areas/fit-zooms are real
# rather than eyeballed.
# ---------------------------------------------------------------------------

MUNI_GEOJSON = WWW / 'public' / 'Municipal_Boundaries_of_NJ.geojson'
DECK_JSON = WWW / 'src' / 'map' / 'tune-deck.json'

# Munis worth their own deck entry: the dense grids where binning is hardest,
# a couple of sprawling townships (very different crash density per px), and
# some small ones where the scope clamp bites hardest.
DECK_MUNIS = [
    'Jersey City', 'Hoboken', 'Weehawken', 'Newark', 'Paterson', 'Trenton',
    'Camden', 'Atlantic City', 'Princeton', 'Montclair', 'Toms River',
    'Hamilton', 'Cherry Hill', 'Vineland', 'Cape May',
]

# Statewide views: two `vp`s (the homepage embed clamp and full-screen), plus a
# phone-shaped one — `areaPx` is the picker's main input and it swings 4× across
# these, so they're distinct regimes, not cosmetic variants.
STATEWIDE = [
    ('nj', 'statewide wide (embed)', 40.07, -74.55, 7.5, 0.5, 'embed'),
    ('njm', 'statewide mid', 40.5, -74.4, 9.0, 0.7, 'full'),
    ('njp', 'statewide phone', 40.2, -74.5, 7.2, 0.5, 'phone'),
]

# Street-scale views (the scope clamp no longer binds; `targetFactor` drives).
STREETS = [
    ('jcs', 'JC street', 40.7441, -74.0585, 16.5, 1.0, 38),
    ('nwks', 'Newark street', 40.7357, -74.1724, 16.5, 1.0, 67),
    ('trns', 'Trenton street', 40.2206, -74.7597, 16.5, 1.0, 20),
]


def _slug(name: str) -> str:
    words = re.sub(r'[^a-z ]', '', name.lower()).split()
    if len(words) == 1:
        return words[0][:4]
    return ''.join(w[0] for w in words)


def _ring_points(geom: dict) -> Iterable[tuple[float, float]]:
    coords = geom['coordinates']
    polys = coords if geom['type'] == 'MultiPolygon' else [coords]
    for poly in polys:
        for ring in poly:
            yield from ((pt[0], pt[1]) for pt in ring)


def _fit_zoom(bbox: tuple[float, float, float, float], vp: tuple[int, int]) -> float:
    """Zoom at which `bbox` just fits `vp` (Web Mercator, small-extent approx)."""
    from math import cos, log2, radians
    w, s, e, n = bbox
    lat = (s + n) / 2
    width_m = (e - w) * 111_320 * cos(radians(lat))
    height_m = (n - s) * 110_574
    vpw, vph = vp
    zw = log2(vpw * 156_543.03392 * cos(radians(lat)) / max(1.0, width_m))
    zh = log2(vph * 156_543.03392 * cos(radians(lat)) / max(1.0, height_m))
    return round(min(zw, zh), 2)


VP_DIMS = {'embed': (1280, 480), 'full': (1470, 900), 'phone': (390, 700)}


@tune.command('deck')
@flag('-n', '--dry-run', help="Print the deck instead of writing it")
@opt('-o', '--out', default=str(DECK_JSON), help='Output path')
def deck_cmd(dry_run, out):
    """Regenerate `www/src/map/tune-deck.json` from the muni boundary file."""
    import json as _json
    feats = _json.loads(MUNI_GEOJSON.read_text())['features']
    counties: dict[str, list[dict]] = {}
    munis: dict[str, dict] = {}
    for f in feats:
        p = f['properties']
        counties.setdefault(p['COUNTY'].title(), []).append(f)
        munis.setdefault(p['NAME'], f)

    def entry(slug, name, feats_, vp, jitter, kind):
        xs = [pt for f in feats_ for pt in _ring_points(f['geometry'])]
        lons = [x for x, _ in xs]
        lats = [y for _, y in xs]
        bbox = (min(lons), min(lats), max(lons), max(lats))
        km2 = round(sum(f['properties']['SQ_MILES'] for f in feats_) * 2.58999, 1)
        return {
            'slug': slug, 'name': name, 'kind': kind,
            'lat': round((bbox[1] + bbox[3]) / 2, 4),
            'lon': round((bbox[0] + bbox[2]) / 2, 4),
            'zoom': _fit_zoom(bbox, VP_DIMS[vp]), 'zoomJitter': jitter,
            'scopeKm2': km2, 'vp': vp,
        }

    deck = []
    for slug, name, lat, lon, zoom, jitter, vp in STATEWIDE:
        deck.append({'slug': slug, 'name': name, 'kind': 'statewide', 'lat': lat, 'lon': lon,
                     'zoom': zoom, 'zoomJitter': jitter, 'scopeKm2': None, 'vp': vp})
    for county, feats_ in sorted(counties.items()):
        deck.append(entry(f'c-{_slug(county)}', f'{county} county', feats_, 'full', 0.4, 'county'))
    for muni in DECK_MUNIS:
        # `NAME` carries the municipal type ("Hamilton Township"), and a bare
        # name can be ambiguous statewide (there are several Hamiltons) — take
        # the largest match, which is the one worth a deck slot.
        matches = [f for name, f in munis.items() if name == muni or name.startswith(muni + ' ')]
        if not matches:
            err(f'muni not found, skipping: {muni}')
            continue
        f = max(matches, key=lambda f: f['properties']['SQ_MILES'])
        deck.append(entry(f'm-{_slug(muni)}', f'{muni} muni', [f], 'full', 0.6, 'muni'))
    for slug, name, lat, lon, zoom, jitter, km2 in STREETS:
        deck.append({'slug': slug, 'name': name, 'kind': 'street', 'lat': lat, 'lon': lon,
                     'zoom': zoom, 'zoomJitter': jitter, 'scopeKm2': km2, 'vp': 'full'})

    slugs = [d['slug'] for d in deck]
    dupes = sorted({s for s in slugs if slugs.count(s) > 1})
    if dupes:
        raise ValueError(f'duplicate deck slugs: {dupes}')
    body = _json.dumps(deck, indent=4) + '\n'
    if dry_run:
        print(body)
    else:
        Path(out).write_text(body)
        err(f'wrote {len(deck)} deck entries to {out}')
