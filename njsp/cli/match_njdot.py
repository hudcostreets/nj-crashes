"""CLI: match NJSP fatal crashes to NJDOT fatal crashes."""
from pathlib import Path

import click
import pandas as pd

from .base import command
from ..match_njdot import match, suggest_candidates


@command
@click.option('-k', '--top-k', type=int, default=3, help="Top-K candidates to emit per residual (with --suggest)")
@click.option('-s', '--suggest', is_flag=True, help="Also emit per-residual top-K candidate suggestions for manual review")
@click.option('-w', '--date-window', type=int, default=3, help="Days on either side of residual to consider as candidates (with --suggest)")
@click.option('-y', '--year', 'years', multiple=True, type=int, help="Restrict matching to these years (default: 2008-2025)")
@click.option('--no-aashto', is_flag=True, help="Skip AASHTO `aashto_combined_crashes.parquet` even if present (test only)")
@click.option('--matches-out', default='njsp/data/njsp_njdot_match.parquet', help="Output parquet for matched pairs")
@click.option('--residuals-out', default='njsp/data/njsp_njdot_residuals.parquet', help="Output parquet for unmatched rows from each side")
@click.option('--suggestions-out', default='njsp/data/njsp_njdot_candidates.csv', help="Output CSV for candidate suggestions (with --suggest)")
def match_njdot(top_k, suggest, date_window, years, no_aashto, matches_out, residuals_out, suggestions_out):
    """Multi-pass match NJSP ↔ NJDOT fatal crashes.

    NJDOT data: per-table `crashes.parquet` (2001-2023) is always loaded.
    `aashto_combined_crashes.parquet` (2024+, schema-mapped from
    `Crash.csv` via `njdot/aashto/to_njdot_schema.py`) is concatenated
    when present. Default year range is 2008-2025; the matcher's
    actual coverage is the intersection of NJSP + NJDOT data ranges.
    """
    njsp = pd.read_parquet('njsp/data/crashes.parquet')
    pertable = pd.read_parquet('njdot/data/crashes.parquet')
    njdot_parts = [pertable]
    aashto_path = Path('njdot/data/aashto_combined_crashes.parquet')
    if aashto_path.exists() and not no_aashto:
        aashto = pd.read_parquet(aashto_path)
        # Drop AASHTO rows with unresolved (cc, mc) — can't be bucketed.
        aashto = aashto.dropna(subset=['cc'])
        # AASHTO supersedes per-table for overlapping years (per-table
        # 2023 has the broad-fatal-flag bug — see agg.py).
        aashto_years = set(aashto['year'].dropna().astype(int))
        njdot_parts = [pertable[~pertable['year'].isin(aashto_years)], aashto]
    njdot = pd.concat(njdot_parts, ignore_index=True)
    yrs = list(years) if years else range(2008, 2026)
    matches, residuals = match(njsp, njdot, years=yrs)
    matches.to_parquet(matches_out, index=False)
    residuals.to_parquet(residuals_out, index=False)
    msg = f"Match NJSP↔NJDOT ({len(matches)} pairs, {len(residuals)} residuals)"
    if suggest:
        cands = suggest_candidates(njsp, njdot, matches, years=yrs, top_k=top_k, date_window=date_window)
        cands.to_csv(suggestions_out, index=False)
        msg += f"; {len(cands)} candidate rows → {suggestions_out}"
    return msg
