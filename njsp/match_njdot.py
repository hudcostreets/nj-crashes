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

_MP_RE = re.compile(r'\bMP\s*(\d+(?:\.\d+)?)', re.IGNORECASE)


def parse_mp_from_location(loc: str | None) -> float | None:
    """Extract milepost from NJSP free-text `location`, e.g. 'Interstate 80 W MP 37.3' → 37.3."""
    if not loc or not isinstance(loc, str):
        return None
    m = _MP_RE.search(loc)
    return float(m.group(1)) if m else None


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


def match(
    njsp: pd.DataFrame,
    njdot: pd.DataFrame,
    years: Iterable[int] = DEFAULT_YEARS,
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

    # --- Residuals report ---
    residuals: list[dict] = []
    for _, r in sp[~sp['njsp_id'].isin(claimed_njsp)].iterrows():
        residuals.append({
            'side': 'njsp',
            'kind': 'unmatched',
            'year': int(r['year']),
            'cc': int(r['cc']),
            'mc': int(r['mc']),
            'date': r['date'],
            'tk': int(r['tk']),
            'hint': r.get('location') or r.get('street') or '',
        })
    for _, r in do[~do['njdot_idx'].isin(claimed_njdot)].iterrows():
        residuals.append({
            'side': 'njdot',
            'kind': 'unmatched',
            'year': int(r['year']),
            'cc': int(r['cc']),
            'mc': int(r['mc']),
            'date': r['date'],
            'tk': int(r['tk']),
            'hint': str(r.get('road') or '') + (f" MP{r['mp']}" if pd.notna(r.get('mp')) else ''),
        })

    matches_df = pd.DataFrame(matches)
    residuals_df = pd.DataFrame(residuals, columns=['side', 'kind', 'year', 'cc', 'mc', 'date', 'tk', 'hint'])
    n_njsp_resid = (residuals_df['side'] == 'njsp').sum() if not residuals_df.empty else 0
    n_njdot_resid = (residuals_df['side'] == 'njdot').sum() if not residuals_df.empty else 0
    err(f"Total: matched {len(matches_df)} pairs ({len(matches_df)/len(sp)*100:.1f}% of NJSP, "
        f"{len(matches_df)/len(do)*100:.1f}% of NJDOT-fatal); "
        f"residuals: {n_njsp_resid} NJSP, {n_njdot_resid} NJDOT")
    return matches_df, residuals_df
