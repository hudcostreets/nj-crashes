"""Match NJSP fatal-crash records to their NJDOT counterparts.

Both sources purport to cover NJ fatal crashes 2008-present; year-level
totals diverge by 1-15% (see `specs/njsp-njdot-fatal-harmonization.md`).
This module runs a multi-pass greedy matcher to reconcile them at
per-crash granularity, producing:

- `njsp_njdot_match.parquet`: `(njsp_id, year, cc, mc, case, pass)` — one
  row per matched pair; `pass` records which pass produced it.
- `njsp_njdot_residuals.parquet`: unmatched rows from each side, with a
  `kind` column categorizing why (`pd_missing`, `route_mismatch`, etc.).

Match passes (apply only to unclaimed residuals from earlier passes):

  1. Exact `(date, cc, mc)` with equal row count + equal `tk` sum.
  2. Same `(date, cc)`, different `mc` — accept when `(route, mp)` agrees
     (|Δmp| ≤ 1.0).
  3. Same `(date)` cross-county with route+mp agreement (catches highway
     crashes assigned to wrong county on one side).
  4. `date ± 1 day` with route+mp agreement (midnight crashes reported
     on different days).

Field normalization (`norm_route`, `parse_mp_from_location`) maps
NJSP's free-text `location` / `highway` columns to numeric route + mp,
matching NJDOT's structured `route` / `mp`.
"""
from __future__ import annotations

import re
from typing import Iterable

import pandas as pd

from nj_crashes.utils.log import err

# Default match scope. NJDOT covers 2001-2023; NJSP covers 2001-present
# (pre-2008 from PDF-only). For matching we restrict to years both sources
# fully cover.
DEFAULT_YEARS = range(2008, 2024)
MP_TOLERANCE = 1.0  # miles

_MP_RE = re.compile(r'\bMP\s*(\d*\.?\d+)', re.IGNORECASE)
# Trailing directional suffix before an MP segment, e.g. "Orange St E MP 5.2"
_MP_AND_DIR_RE = re.compile(r'\s+[NSEW]\b.*$|\s*MP\s*\d*\.?\d+.*$', re.IGNORECASE)
# Trailing "at CROSS ST" segments
_AT_CROSS_RE = re.compile(r'\s+at\s+.*$', re.IGNORECASE)
# Leading street number (e.g. "200 RIVERWOOD DR" or "2361 SH 66")
_LEAD_NUM_RE = re.compile(r'^\s*\d+\s+')
# Abbreviation expansion (street-type only, for normalization comparison)
_ABBREV = {
    'ST': 'STREET', 'AVE': 'AVENUE', 'AV': 'AVENUE', 'RD': 'ROAD',
    'DR': 'DRIVE', 'BLVD': 'BOULEVARD', 'LN': 'LANE', 'CT': 'COURT',
    'PL': 'PLACE', 'PKWY': 'PARKWAY', 'TPKE': 'TURNPIKE', 'HWY': 'HIGHWAY',
    'N': 'NORTH', 'S': 'SOUTH', 'E': 'EAST', 'W': 'WEST',
    'NO': 'NORTH', 'SO': 'SOUTH',
    'SH': 'STATEHIGHWAY', 'NJ': 'STATEHIGHWAY', 'US': 'USHIGHWAY',
    'I': 'INTERSTATE',
}


def parse_mp_from_location(loc: str | None) -> float | None:
    """Extract milepost from NJSP free-text `location`, e.g. 'Interstate 80 W MP 37.3' → 37.3."""
    if not loc or not isinstance(loc, str):
        return None
    m = _MP_RE.search(loc)
    return float(m.group(1)) if m else None


def norm_street(s: str | None) -> str | None:
    """Normalize a street-name string for fuzzy-matching across sources.

    NJSP's `location` / `street` and NJDOT's `road` / `cross_street` have
    different casing, punctuation, trailing direction/MP, street numbers,
    and standard abbreviations. Canonicalize to: uppercase, no leading
    number prefix, no trailing direction/MP/at-cross segment, standard
    abbreviations expanded, single spaces, no punctuation.

    Examples:
      "Orange St E MP 5.2"  → "ORANGE STREET"
      "ORANGE ST MP0.24"    → "ORANGE STREET"
      "S. Mill Rd E MP 0"   → "SOUTH MILL ROAD"
      "2361 SH 66"          → "STATEHIGHWAY 66"
      "200 RIVERWOOD DR"    → "RIVERWOOD DRIVE"
    """
    if not s or not isinstance(s, str):
        return None
    s = s.strip().upper()
    # Strip trailing "at CROSS ST" phrase
    s = _AT_CROSS_RE.sub('', s)
    # Strip trailing direction + MP segments
    s = _MP_AND_DIR_RE.sub('', s)
    # Strip "**" markers sometimes in NJDOT road names
    s = s.replace('**', '')
    # Drop punctuation (periods, commas)
    s = re.sub(r'[.,;:()\'"]', '', s)
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    # Drop leading street-number
    s = _LEAD_NUM_RE.sub('', s)
    # Expand abbreviations token-by-token
    tokens = [_ABBREV.get(tok, tok) for tok in s.split()]
    s = ' '.join(tokens).strip()
    return s or None


def street_hints_agree(s_hint: str | None, d_road: str | None,
                       d_cross: str | None = None) -> bool:
    """True if normalized NJSP hint matches NJDOT `road` or `cross_street`."""
    s_norm = norm_street(s_hint)
    if not s_norm:
        return False
    for d in (d_road, d_cross):
        d_norm = norm_street(d)
        if d_norm and s_norm == d_norm:
            return True
    return False


def norm_route(s: str | int | None) -> str | None:
    """Normalize a route value to a stable string for comparison.

    Strips '.0' suffixes (pandas Int → str), leading zeros, whitespace.
    Returns None for empty/NaN/non-route values.
    """
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return None
    s = str(s).strip()
    if not s or s.lower() in ('nan', 'none', '<na>'):
        return None
    if s.endswith('.0'):
        s = s[:-2]
    s = s.lstrip('0') or '0'
    return s


def _prep_njsp(njsp: pd.DataFrame, years: Iterable[int]) -> pd.DataFrame:
    """Subset NJSP crashes to `years`; add `date`, `mp`, `route`, `njsp_id`.

    `njsp_id` preserves the original index (the FAUQStats record id), not
    the row position. Index is `njsp_id` for `.loc` lookup convenience.
    """
    df = njsp.copy()
    df['year'] = df['dt'].dt.year
    df = df[df['year'].isin(list(years))].copy()
    df['date'] = df['dt'].dt.date
    df['mp'] = df['location'].apply(parse_mp_from_location)
    df['route'] = df['highway'].apply(norm_route)
    df['njsp_id'] = df.index
    df = df.reset_index(drop=True).set_index('njsp_id', drop=False)
    df.index.name = '_njsp_id'
    return df


def _prep_njdot(njdot_fatal: pd.DataFrame, years: Iterable[int]) -> pd.DataFrame:
    """Subset NJDOT fatal crashes to `years`; add normalized `date`, `route`,
    and `njdot_idx` (= original `crashes.parquet` row id, preserved as the
    new index for `.loc` lookups)."""
    df = njdot_fatal.copy()
    df = df[df['year'].isin(list(years))].copy()
    df['date'] = df['dt'].dt.date
    df['route'] = df['route'].apply(norm_route)
    df['njdot_idx'] = df.index
    df = df.reset_index(drop=True).set_index('njdot_idx', drop=False)
    df.index.name = '_njdot_idx'
    return df


def _pair_groups(xg: pd.DataFrame, pg: pd.DataFrame) -> list[tuple[int, int]]:
    """Pair rows from two equally-sized groups by descending `tk`.

    Returns list of (njsp_id, njdot_idx) pairs. Returns [] if the
    sorted-by-tk pairing produces any tk mismatch.
    """
    xs = xg.sort_values('tk', ascending=False).reset_index(drop=True)
    ps = pg.sort_values('tk', ascending=False).reset_index(drop=True)
    if len(xs) != len(ps):
        return []
    pairs = []
    for (_, xrow), (_, prow) in zip(xs.iterrows(), ps.iterrows()):
        if xrow['tk'] != prow['tk']:
            return []
        pairs.append((int(xrow['njsp_id']), int(prow['njdot_idx'])))
    return pairs


def _route_mp_agree(s_route: str | None, s_mp: float | None,
                    d_route: str | None, d_mp: float | None) -> bool:
    """True if NJSP and NJDOT route+mp agree (within `MP_TOLERANCE`).

    Routes must both be present and equal. MP must agree within tolerance,
    OR both must be missing.
    """
    if not s_route or not d_route or s_route != d_route:
        return False
    if s_mp is None and d_mp is None:
        return True
    if s_mp is None or d_mp is None:
        return False
    return abs(s_mp - d_mp) <= MP_TOLERANCE


def load_manual_matches(path: str = 'njsp/data/njsp_njdot_manual_matches.csv') -> pd.DataFrame:
    """Load manually-curated NJSP↔NJDOT pairings that the heuristic passes
    can't produce (e.g. route alias cases, day-boundary crashes with too
    much time skew, NJSP records where the location text is too cryptic
    for `norm_street`).

    CSV schema: `njsp_id, year, cc, mc, case, note`. The (year, cc, mc,
    case) tuple is the NJDOT PK. `note` is optional human commentary.

    Returns an empty DataFrame if the file doesn't exist — manual
    overrides are strictly additive, not required.
    """
    import os
    if not os.path.exists(path):
        return pd.DataFrame(columns=['njsp_id', 'year', 'cc', 'mc', 'case', 'note'])
    df = pd.read_csv(path)
    if 'note' not in df.columns:
        df['note'] = ''
    df['note'] = df['note'].fillna('')
    return df


def match(
    njsp: pd.DataFrame,
    njdot: pd.DataFrame,
    years: Iterable[int] = DEFAULT_YEARS,
    manual_matches: pd.DataFrame | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Match NJSP fatal crashes to NJDOT fatal crashes via multi-pass greedy.

    Returns (matches_df, residuals_df).

    `matches_df` columns: `njsp_id, year, cc, mc, case, tk_njsp, tk_njdot, pass`.
    `residuals_df` columns: `kind, side, year, cc, mc, date, tk, hint`.
    """
    years = list(years)
    sp = _prep_njsp(njsp, years)
    do = _prep_njdot(njdot[njdot['severity'] == 'f'], years)
    err(f"Matching NJSP={len(sp)} ↔ NJDOT-fatal={len(do)} for years {years[0]}-{years[-1]}")

    claimed_njsp: set[int] = set()
    claimed_njdot: set[int] = set()
    matches: list[dict] = []

    def _record(njsp_id: int, njdot_idx: int, pass_n: int) -> None:
        d = do.loc[njdot_idx]
        s = sp.loc[njsp_id]
        matches.append({
            'njsp_id': int(s['njsp_id']),
            'year': int(d['year']),
            'cc': int(d['cc']),
            'mc': int(d['mc']),
            'case': str(d['case']),
            'tk_njsp': int(s['tk']),
            'tk_njdot': int(d['tk']),
            'pass': pass_n,
        })
        claimed_njsp.add(njsp_id)
        claimed_njdot.add(njdot_idx)

    # --- Pass 0: manual overrides (human-curated pairings) ---
    # Applied FIRST so heuristic passes can't double-claim these rows.
    if manual_matches is None:
        manual_matches = load_manual_matches()
    if len(manual_matches):
        # Build njdot index from (year, cc, mc, case) → njdot_idx
        do_pk = do.set_index(['year', 'cc', 'mc', 'case'])['njdot_idx']
        n_manual = 0
        for _, m in manual_matches.iterrows():
            sid = int(m['njsp_id'])
            if sid not in sp.index:
                err(f"  manual-match skipped: njsp_id {sid} not in NJSP data (filtered out by years?)")
                continue
            pk = (int(m['year']), int(m['cc']), int(m['mc']), str(m['case']))
            if pk not in do_pk.index:
                err(f"  manual-match skipped: NJDOT PK {pk} not found")
                continue
            did = int(do_pk.loc[pk])
            _record(sid, did, 0)
            n_manual += 1
        err(f"  pass 0 (manual overrides): {n_manual} pairs")

    # --- Pass 1: exact (date, cc, mc) with equal row count + tk sum ---
    for key, xg in sp.groupby(['date', 'cc', 'mc'], sort=False):
        pg = do[(do['date'] == key[0]) & (do['cc'] == key[1]) & (do['mc'] == key[2])]
        if len(pg) and len(pg) == len(xg) and pg['tk'].sum() == xg['tk'].sum():
            for sid, did in _pair_groups(xg, pg):
                _record(sid, did, 1)
    err(f"  pass 1 ((date,cc,mc) exact): {sum(m['pass']==1 for m in matches)} pairs")

    # --- Pass 2: same (date, cc), different mc — accept on route+mp ---
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for key, xg in sp_left.groupby(['date', 'cc'], sort=False):
        pg = do_left[(do_left['date'] == key[0]) & (do_left['cc'] == key[1])]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if (srow['tk'] == drow['tk']
                        and _route_mp_agree(srow['route'], srow['mp'],
                                             drow['route'], drow['mp'])):
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 2)
                    break
    err(f"  pass 2 ((date,cc) cross-mc on route+mp): {sum(m['pass']==2 for m in matches)} pairs")

    # --- Pass 3: same (date), cross-county on route+mp ---
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for date, xg in sp_left.groupby('date', sort=False):
        pg = do_left[do_left['date'] == date]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if (srow['tk'] == drow['tk']
                        and _route_mp_agree(srow['route'], srow['mp'],
                                             drow['route'], drow['mp'])):
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 3)
                    break
    err(f"  pass 3 (date cross-county on route+mp): {sum(m['pass']==3 for m in matches)} pairs")

    # --- Pass 4: ±1 day, route+mp ---
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for _, srow in sp_left.iterrows():
        if srow['njsp_id'] in claimed_njsp:
            continue
        if not srow['route'] or srow['mp'] is None:
            continue
        from datetime import timedelta
        for delta in (timedelta(days=-1), timedelta(days=1)):
            target = srow['date'] + delta
            cands = do_left[
                (do_left['date'] == target)
                & (do_left['route'] == srow['route'])
                & (~do_left['njdot_idx'].isin(claimed_njdot))
            ]
            for _, drow in cands.iterrows():
                if (srow['tk'] == drow['tk']
                        and _route_mp_agree(srow['route'], srow['mp'],
                                             drow['route'], drow['mp'])):
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 4)
                    break
            if srow['njsp_id'] in claimed_njsp:
                break
    err(f"  pass 4 (date±1, route+mp): {sum(m['pass']==4 for m in matches)} pairs")

    # --- Pass 5: same (date, cc, tk), time-of-day within ±3 hours ---
    # Catches side-street crashes with no route info (residual kind:
    # `unresolved`) where the two sources agree on date, county, and
    # fatality count, and the dt times are close enough to be the same
    # crash. Skip if both sides have routes that disagree (those are
    # `route_mismatch` residuals — different physical locations, not
    # the same crash despite same time).
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for key, xg in sp_left.groupby(['date', 'cc'], sort=False):
        pg = do_left[(do_left['date'] == key[0]) & (do_left['cc'] == key[1])]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if srow['tk'] != drow['tk']:
                    continue
                # If both sides have routes, they must agree.
                if srow['route'] and drow['route'] and srow['route'] != drow['route']:
                    continue
                # Compare dt times (align by UTC epoch).
                s_ts = pd.Timestamp(srow['dt']).tz_convert('UTC') if pd.Timestamp(srow['dt']).tz else pd.Timestamp(srow['dt']).tz_localize('US/Eastern').tz_convert('UTC')
                d_ts = pd.Timestamp(drow['dt']).tz_convert('UTC') if pd.Timestamp(drow['dt']).tz else pd.Timestamp(drow['dt']).tz_localize('US/Eastern').tz_convert('UTC')
                if abs((s_ts - d_ts).total_seconds()) <= 3 * 3600:
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 5)
                    break
    err(f"  pass 5 ((date,cc,tk), ±3hr time): {sum(m['pass']==5 for m in matches)} pairs")

    # --- Pass 6: same (date, cc, tk, pk) — pedestrians-killed decomposition ---
    # Both sources track `pk` (pedestrians killed); the decomposition
    # disambiguates multiple same-tk crashes on same date+cc (rare but
    # happens in high-fatality days).
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for key, xg in sp_left.groupby(['date', 'cc'], sort=False):
        pg = do_left[(do_left['date'] == key[0]) & (do_left['cc'] == key[1])]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            if pd.isna(srow.get('pk')):
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if pd.isna(drow.get('pk')):
                    continue
                if srow['tk'] == drow['tk'] and srow['pk'] == drow['pk']:
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 6)
                    break
    err(f"  pass 6 ((date,cc,tk,pk) decomposition): {sum(m['pass']==6 for m in matches)} pairs")

    # --- Pass 7: route+mp agree, tk disagrees (<= 2 apart) ---
    # Inspection of `route_mismatch` residuals showed most pairs have
    # matching route+mp but different `tk` — usually because one source
    # recorded a later-died hospital fatality the other didn't, or because
    # one counted a non-occupant fatality (pedestrian + driver = 2 deaths
    # vs just the driver = 1). Accept these with `tk_delta` recorded;
    # downstream consumers can decide whether to trust one side.
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for key, xg in sp_left.groupby(['date', 'cc'], sort=False):
        pg = do_left[(do_left['date'] == key[0]) & (do_left['cc'] == key[1])]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            if not srow['route'] or srow['mp'] is None:
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if not _route_mp_agree(srow['route'], srow['mp'],
                                        drow['route'], drow['mp']):
                    continue
                if abs(int(srow['tk']) - int(drow['tk'])) > 2:
                    continue
                _record(int(srow['njsp_id']), int(drow['njdot_idx']), 7)
                break
    err(f"  pass 7 (route+mp agree, tk disagrees): {sum(m['pass']==7 for m in matches)} pairs")

    # --- Pass 8: same (date, cc), street-name fuzzy match, tk within 2 ---
    # Targets `unresolved` residuals on side-streets with no route+mp.
    # NJSP's `street` / `location` text vs NJDOT's `road` / `cross_street`
    # differ in casing, abbreviations, direction suffixes, and street-
    # number prefixes but often name the same physical road. Normalize
    # via `norm_street` and compare; `tk` may differ up to 2 (same logic
    # as pass 7).
    sp_left = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_left = do[~do['njdot_idx'].isin(claimed_njdot)]
    for key, xg in sp_left.groupby(['date', 'cc'], sort=False):
        pg = do_left[(do_left['date'] == key[0]) & (do_left['cc'] == key[1])]
        if pg.empty or xg.empty:
            continue
        for _, srow in xg.iterrows():
            if srow['njsp_id'] in claimed_njsp:
                continue
            # NJSP's street text: prefer `street` if set, else `location`
            s_street = srow.get('street') or srow.get('location')
            s_norm = norm_street(s_street)
            if not s_norm:
                continue
            for _, drow in pg.iterrows():
                if drow['njdot_idx'] in claimed_njdot:
                    continue
                if abs(int(srow['tk']) - int(drow['tk'])) > 2:
                    continue
                if street_hints_agree(s_street, drow.get('road'), drow.get('cross_street')):
                    _record(int(srow['njsp_id']), int(drow['njdot_idx']), 8)
                    break
    err(f"  pass 8 ((date,cc) street-name fuzzy): {sum(m['pass']==8 for m in matches)} pairs")

    # --- Residuals report ---
    # Categorize each residual row by WHY it didn't match:
    #   `pd_missing`  — no same-date crash on the other side ANYWHERE
    #                   (likely a filing gap or an NJSP-only / NJDOT-only
    #                   record of a true crash — e.g. PIPW didn't report)
    #   `route_mismatch` — same (date, cc) present on both sides but
    #                   `route` disagrees; could be a genuine crash-pair
    #                   needing human review
    #   `unresolved`  — neither of the above; usually means the crash is
    #                   on a side-street (no route info) so our MP-based
    #                   passes couldn't fire
    residuals: list[dict] = []

    sp_unmatched = sp[~sp['njsp_id'].isin(claimed_njsp)]
    do_unmatched = do[~do['njdot_idx'].isin(claimed_njdot)]
    # Index same-date presence on the opposing side for fast lookup
    sp_dates = set(sp_unmatched['date'])
    do_dates = set(do_unmatched['date'])
    sp_date_cc = set(zip(sp_unmatched['date'], sp_unmatched['cc']))
    do_date_cc = set(zip(do_unmatched['date'], do_unmatched['cc']))

    def _categorize(row: pd.Series, side: str) -> str:
        date, cc = row['date'], int(row['cc'])
        other_dates = do_dates if side == 'njsp' else sp_dates
        other_date_cc = do_date_cc if side == 'njsp' else sp_date_cc
        if date not in other_dates:
            return 'pd_missing'
        if (date, cc) in other_date_cc and row.get('route'):
            return 'route_mismatch'
        return 'unresolved'

    for _, r in sp_unmatched.iterrows():
        residuals.append({
            'side': 'njsp',
            'kind': _categorize(r, 'njsp'),
            'year': int(r['year']),
            'cc': int(r['cc']),
            'mc': int(r['mc']),
            'date': r['date'],
            'tk': int(r['tk']),
            'route': r.get('route'),
            'mp': r.get('mp'),
            'hint': r.get('location') or r.get('street') or '',
        })
    for _, r in do_unmatched.iterrows():
        mp_val = r.get('mp')
        mp_suffix = f" MP{mp_val}" if pd.notna(mp_val) else ''
        residuals.append({
            'side': 'njdot',
            'kind': _categorize(r, 'njdot'),
            'year': int(r['year']),
            'cc': int(r['cc']),
            'mc': int(r['mc']),
            'date': r['date'],
            'tk': int(r['tk']),
            'route': r.get('route'),
            'mp': float(mp_val) if pd.notna(mp_val) else None,
            'hint': str(r.get('road') or '') + mp_suffix,
        })

    matches_df = pd.DataFrame(matches)
    residuals_df = pd.DataFrame(
        residuals,
        columns=['side', 'kind', 'year', 'cc', 'mc', 'date', 'tk', 'route', 'mp', 'hint'],
    )
    n_njsp_resid = (residuals_df['side'] == 'njsp').sum() if not residuals_df.empty else 0
    n_njdot_resid = (residuals_df['side'] == 'njdot').sum() if not residuals_df.empty else 0
    err(f"Total: matched {len(matches_df)} pairs ({len(matches_df)/len(sp)*100:.1f}% of NJSP, "
        f"{len(matches_df)/len(do)*100:.1f}% of NJDOT-fatal); "
        f"residuals: {n_njsp_resid} NJSP, {n_njdot_resid} NJDOT")
    if not residuals_df.empty:
        by_kind = residuals_df.groupby(['side', 'kind']).size().unstack(fill_value=0)
        err(f"Residual kinds:\n{by_kind.to_string()}")
    return matches_df, residuals_df
