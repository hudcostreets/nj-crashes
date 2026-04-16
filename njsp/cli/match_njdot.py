"""CLI: match NJSP fatal crashes to NJDOT fatal crashes."""
import click
import pandas as pd

from .base import command
from ..match_njdot import match, suggest_candidates


@command
@click.option('-k', '--top-k', type=int, default=3, help="Top-K candidates to emit per residual (with --suggest)")
@click.option('-s', '--suggest', is_flag=True, help="Also emit per-residual top-K candidate suggestions for manual review")
@click.option('-w', '--date-window', type=int, default=3, help="Days on either side of residual to consider as candidates (with --suggest)")
@click.option('-y', '--year', 'years', multiple=True, type=int, help="Restrict matching to these years (default: 2008-2023)")
@click.option('--matches-out', default='njsp/data/njsp_njdot_match.parquet', help="Output parquet for matched pairs")
@click.option('--residuals-out', default='njsp/data/njsp_njdot_residuals.parquet', help="Output parquet for unmatched rows from each side")
@click.option('--suggestions-out', default='njsp/data/njsp_njdot_candidates.csv', help="Output CSV for candidate suggestions (with --suggest)")
def match_njdot(top_k, suggest, date_window, years, matches_out, residuals_out, suggestions_out):
    """Multi-pass match NJSP ↔ NJDOT fatal crashes."""
    njsp = pd.read_parquet('njsp/data/crashes.parquet')
    njdot = pd.read_parquet('njdot/data/crashes.parquet')
    yrs = list(years) if years else range(2008, 2024)
    matches, residuals = match(njsp, njdot, years=yrs)
    matches.to_parquet(matches_out, index=False)
    residuals.to_parquet(residuals_out, index=False)
    msg = f"Match NJSP↔NJDOT ({len(matches)} pairs, {len(residuals)} residuals)"
    if suggest:
        cands = suggest_candidates(njsp, njdot, matches, years=yrs, top_k=top_k, date_window=date_window)
        cands.to_csv(suggestions_out, index=False)
        msg += f"; {len(cands)} candidate rows → {suggestions_out}"
    return msg
