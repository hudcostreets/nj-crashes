#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow"]
# ///
"""3-way fatal-crash matcher: NJSP (SP) ↔ NJDOT per-table (DOTr) ↔ NJDOT AASHTO (DOTa).

Produces a single table where each row is a canonical fatal crash event, with
flags showing which of the three sources contain it. Used to characterize
disagreements between NJSP and NJDOT (and between NJDOT's two pipelines).

Outputs:
  - njsp/data/three_way_fatals.parquet  (long form, one row per canonical event)
  - njsp/data/three_way_fatals.csv      (same, human-readable)

Source semantics:
  - SP   : NJSP fatal crashes (XML feed + PDF backfill)
  - DOTr : NJDOT per-table archive (2001-2023), severity='f'
           (broad def: tk>0 OR Indicator=Y)
  - DOTa : NJDOT AASHTO Crash.csv (2023-2025), Fatal Crash Indicator='Y'
           (strict def, NJSP-aligned)

DOTr↔DOTa joined directly via case_norm (digits-only Case Number).
SP↔DOTr and SP↔DOTa each use the existing fuzzy matcher in match_njdot.py.
"""
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
from njsp.match_njdot import match  # type: ignore

err = partial(print, file=sys.stderr)


def case_norm(s: pd.Series) -> pd.Series:
    return s.astype('string').str.replace(r'\D', '', regex=True)


def load_sources():
    err("Loading NJSP, DOTr (per-table), DOTa (AASHTO)…")
    sp = pd.read_parquet('njsp/data/crashes.parquet')

    pertable = pd.read_parquet('njdot/data/crashes.parquet')
    aashto = pd.read_parquet('njdot/data/aashto_combined_crashes.parquet')
    aashto = aashto.dropna(subset=['cc'])

    aashto_years = set(aashto['year'].dropna().astype(int))
    # DOTr: per-table fatals for years NOT in AASHTO + per-table years overlapping AASHTO
    # (we keep both sides — per-table 2023 is the broad-def DOTr signal we want to expose).
    dotr = pertable[pertable['severity'] == 'f'].copy()
    dota = aashto[aashto['severity'] == 'f'].copy()

    err(f"  SP   : {len(sp):,} fatals  ({sp['dt'].dt.year.min()}–{sp['dt'].dt.year.max()})")
    err(f"  DOTr : {len(dotr):,} fatals  ({dotr['year'].min()}–{dotr['year'].max()})")
    err(f"  DOTa : {len(dota):,} fatals  ({dota['year'].min()}–{dota['year'].max()})  AASHTO years={sorted(aashto_years)}")
    return sp, dotr, dota


def match_sp_to_njdot(sp: pd.DataFrame, njdot: pd.DataFrame, label: str, years):
    """Wrap match() — feed it SP + njdot, where njdot must have severity='f'."""
    nj = njdot.copy()
    nj['severity'] = 'f'  # ensure flag
    matches, residuals = match(sp, nj, years=years)
    err(f"  SP↔{label}: {len(matches)} matches, {len(residuals)} residuals")
    return matches, residuals


@click.command()
@click.option('-y', '--start-year', type=int, default=2008)
@click.option('-Y', '--end-year', type=int, default=2025)
@click.option('-o', '--out-parquet', type=click.Path(path_type=Path), default=Path('njsp/data/three_way_fatals.parquet'))
@click.option('-c', '--out-csv', type=click.Path(path_type=Path), default=Path('njsp/data/three_way_fatals.csv'))
def main(start_year: int, end_year: int, out_parquet: Path, out_csv: Path):
    years = list(range(start_year, end_year + 1))
    sp, dotr, dota = load_sources()

    # === DOTr ↔ DOTa: case_norm join ===
    err("\nDOTr↔DOTa via case_norm…")
    dotr['cn'] = case_norm(dotr['case'])
    dota['cn'] = case_norm(dota['case'])
    # Restrict each to years in [start_year, end_year]
    dotr = dotr[dotr['year'].between(start_year, end_year)].copy()
    dota = dota[dota['year'].between(start_year, end_year)].copy()
    # Build event index per source
    dotr['r_idx'] = range(len(dotr))
    dota['a_idx'] = range(len(dota))

    # case_norm keys can have collisions across years, so join on (year, cn).
    r_key = dotr.set_index(['year', 'cn'])['r_idx']
    a_key = dota.set_index(['year', 'cn'])['a_idx']
    r_a_pairs = r_key.to_frame().join(a_key.to_frame(), how='inner').reset_index()
    err(f"  DOTr∩DOTa pairs (case_norm exact): {len(r_a_pairs)}")
    # Ambiguous case_norm matches (multiple a per r or vice versa) — count for visibility
    if r_a_pairs.duplicated('r_idx').any() or r_a_pairs.duplicated('a_idx').any():
        err(f"    (ambiguous: {r_a_pairs.duplicated('r_idx').sum()} dup r, {r_a_pairs.duplicated('a_idx').sum()} dup a)")

    # === SP ↔ DOTr ===
    err("\nSP↔DOTr matching…")
    m_r, _ = match_sp_to_njdot(sp, dotr, 'DOTr', years)
    # m_r has columns: njsp_id, year, cc, mc, case, ...
    # Re-link to r_idx via (year, cc, mc, case)
    dotr_pk = dotr.set_index(['year', 'cc', 'mc', 'case'])['r_idx']
    m_r['r_idx'] = m_r.apply(
        lambda row: dotr_pk.get((int(row['year']), int(row['cc']), int(row['mc']), str(row['case'])), None),
        axis=1,
    )

    # === SP ↔ DOTa ===
    err("\nSP↔DOTa matching…")
    m_a, _ = match_sp_to_njdot(sp, dota, 'DOTa', years)
    dota_pk = dota.set_index(['year', 'cc', 'mc', 'case'])['a_idx']
    m_a['a_idx'] = m_a.apply(
        lambda row: dota_pk.get((int(row['year']), int(row['cc']), int(row['mc']), str(row['case'])), None),
        axis=1,
    )

    # === Compose 3-way table ===
    # Event = a triple (sp_id?, r_idx?, a_idx?). We seed events from union of
    # (a) SP fatals with year in [start, end], (b) DOTr fatals, (c) DOTa fatals.
    # Then merge: the same event surfaces from multiple sources; we need to dedupe.

    # Step 1: build a unified event registry. NJSP's index is `id`
    # (FAUQStats record id) — that's the same value the matcher returns
    # as `njsp_id`, so we use the index directly as `sp_id`.
    sp_in = sp[sp['dt'].dt.year.between(start_year, end_year)].copy()
    sp_in['sp_id'] = sp_in.index

    # Seed events from SP-matched-R and SP-matched-A
    events = []  # list of dicts

    # Map sp_id → r_idx (if matched), sp_id → a_idx (if matched)
    sp_to_r = m_r.set_index('njsp_id')['r_idx'].to_dict()
    sp_to_a = m_a.set_index('njsp_id')['a_idx'].to_dict()
    # r_idx → a_idx (via case_norm join)
    r_to_a = r_a_pairs.set_index('r_idx')['a_idx'].to_dict()
    a_to_r = r_a_pairs.set_index('a_idx')['r_idx'].to_dict()

    used_r: set[int] = set()
    used_a: set[int] = set()

    # SP-anchored events
    for _, s in sp_in.iterrows():
        sid = int(s['sp_id'])
        r_idx = sp_to_r.get(sid)
        a_idx = sp_to_a.get(sid)
        # If SP matched R, also link via R∩A
        if r_idx is not None and a_idx is None:
            a_idx = r_to_a.get(int(r_idx))
        # Vice versa
        if a_idx is not None and r_idx is None:
            r_idx = a_to_r.get(int(a_idx))
        if r_idx is not None:
            used_r.add(int(r_idx))
        if a_idx is not None:
            used_a.add(int(a_idx))
        events.append({
            'sp_id': sid,
            'r_idx': int(r_idx) if r_idx is not None else None,
            'a_idx': int(a_idx) if a_idx is not None else None,
        })

    # R-only events (R fatals not yet attached to an SP-anchored event)
    for r_idx in dotr['r_idx']:
        if int(r_idx) in used_r:
            continue
        a_idx = r_to_a.get(int(r_idx))
        if a_idx is not None and int(a_idx) in used_a:
            # already part of an existing event; skip (shouldn't really happen)
            continue
        if a_idx is not None:
            used_a.add(int(a_idx))
        used_r.add(int(r_idx))
        events.append({
            'sp_id': None,
            'r_idx': int(r_idx),
            'a_idx': int(a_idx) if a_idx is not None else None,
        })

    # A-only events (A fatals not yet attached)
    for a_idx in dota['a_idx']:
        if int(a_idx) in used_a:
            continue
        used_a.add(int(a_idx))
        events.append({
            'sp_id': None,
            'r_idx': None,
            'a_idx': int(a_idx),
        })

    # Hydrate events with metadata from each source
    sp_meta = sp_in.set_index('sp_id')
    dotr_meta = dotr.set_index('r_idx')
    dota_meta = dota.set_index('a_idx')

    rows = []
    for e in events:
        sid, r, a = e['sp_id'], e['r_idx'], e['a_idx']
        in_sp = sid is not None
        in_r = r is not None
        in_a = a is not None
        src = ''.join(c for c, t in zip('SRA', (in_sp, in_r, in_a)) if t)

        # Prefer DOTa metadata > DOTr > SP for canonical fields (DOTa has cleaner schema).
        meta = {}
        if in_a:
            ar = dota_meta.loc[a]
            meta = {
                'year': int(ar['year']) if pd.notna(ar.get('year')) else None,
                'dt': ar.get('dt'),
                'cc': int(ar['cc']) if pd.notna(ar.get('cc')) else None,
                'mc': int(ar['mc']) if pd.notna(ar.get('mc')) else None,
                'case': str(ar.get('case', '')),
                'route': str(ar.get('route', '')) if pd.notna(ar.get('route')) else None,
                'mp': float(ar['mp']) if pd.notna(ar.get('mp')) else None,
                'road': str(ar.get('road', '')) if pd.notna(ar.get('road')) else None,
            }
        elif in_r:
            rr = dotr_meta.loc[r]
            meta = {
                'year': int(rr['year']),
                'dt': rr.get('dt'),
                'cc': int(rr['cc']) if pd.notna(rr.get('cc')) else None,
                'mc': int(rr['mc']) if pd.notna(rr.get('mc')) else None,
                'case': str(rr.get('case', '')),
                'route': str(rr.get('route', '')) if pd.notna(rr.get('route')) else None,
                'mp': float(rr['mp']) if pd.notna(rr.get('mp')) else None,
                'road': str(rr.get('road', '')) if pd.notna(rr.get('road')) else None,
            }
        else:
            ss = sp_meta.loc[sid]
            meta = {
                'year': int(ss['dt'].year),
                'dt': ss['dt'],
                'cc': int(ss.get('cc')) if pd.notna(ss.get('cc')) else None,
                'mc': int(ss.get('mc')) if pd.notna(ss.get('mc')) else None,
                'case': None,
                'route': str(ss.get('route', '')) if pd.notna(ss.get('route')) else None,
                'mp': float(ss['mp']) if pd.notna(ss.get('mp')) else None,
                'road': str(ss.get('location', '')) if pd.notna(ss.get('location')) else None,
            }

        # Death counts per source
        tk_sp = int(sp_meta.loc[sid, 'tk']) if in_sp and pd.notna(sp_meta.loc[sid, 'tk']) else None
        tk_r = int(dotr_meta.loc[r, 'tk']) if in_r and pd.notna(dotr_meta.loc[r, 'tk']) else None
        tk_a = int(dota_meta.loc[a, 'tk']) if in_a and pd.notna(dota_meta.loc[a, 'tk']) else None
        tk_a_broad = int(dota_meta.loc[a, 'tk_broad']) if in_a and pd.notna(dota_meta.loc[a, 'tk_broad']) else None

        rows.append({
            'src': src,
            'in_sp': in_sp,
            'in_r': in_r,
            'in_a': in_a,
            'sp_id': sid,
            'r_idx': r,
            'a_idx': a,
            'tk_sp': tk_sp,
            'tk_r': tk_r,
            'tk_a': tk_a,
            'tk_a_broad': tk_a_broad,
            **meta,
        })

    out = pd.DataFrame(rows)
    # `dt` mixes tz-naive (NJSP) and tz-aware (DOTr/DOTa); normalize to tz-naive UTC
    # for consistent sort order.
    out['dt'] = pd.to_datetime(out['dt'], utc=True, errors='coerce').dt.tz_localize(None)
    out = out.sort_values(['year', 'dt', 'src']).reset_index(drop=True)

    err(f"\nTotal canonical events: {len(out)}")
    err("\nBreakdown by source-set, by year:")
    pivot = out.pivot_table(index='year', columns='src', aggfunc='size', fill_value=0)
    err(pivot.to_string())

    out_parquet.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(out_parquet, index=False)
    out.to_csv(out_csv, index=False)
    err(f"\nWrote {out_parquet} ({len(out):,} rows)")
    err(f"Wrote {out_csv}")


if __name__ == '__main__':
    main()
