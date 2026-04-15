"""CLI: match NJSP fatal crashes to NJDOT fatal crashes."""
import click
import pandas as pd

from .base import command
from ..match_njdot import match


@command
@click.option('-y', '--year', 'years', multiple=True, type=int,
              help="Restrict matching to these years (default: 2008-2023)")
@click.option('--matches-out', default='njsp/data/njsp_njdot_match.parquet',
              help="Output parquet for matched pairs")
@click.option('--residuals-out', default='njsp/data/njsp_njdot_residuals.parquet',
              help="Output parquet for unmatched rows from each side")
def match_njdot(years, matches_out, residuals_out):
    """Multi-pass match NJSP ↔ NJDOT fatal crashes."""
    njsp = pd.read_parquet('njsp/data/crashes.parquet')
    njdot = pd.read_parquet('njdot/data/crashes.parquet')
    yrs = list(years) if years else range(2008, 2024)
    matches, residuals = match(njsp, njdot, years=yrs)
    matches.to_parquet(matches_out, index=False)
    residuals.to_parquet(residuals_out, index=False)
    return f"Match NJSP↔NJDOT ({len(matches)} pairs, {len(residuals)} residuals)"
