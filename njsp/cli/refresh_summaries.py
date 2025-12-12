import click
from utz import err

from njsp.cli.base import command


@command
@click.option('-k', '--kernel', default='python3')
@click.argument('years', nargs=-1)
def refresh_summaries(kernel, years):
    """Update NJSP annual summary PDFs (fetch-summaries.ipynb).

    NOTE: Disabled as of Dec 2024 - NJSP moved to njsp.njoag.gov and the
    "Victim Classification by County" PDFs are no longer available. Historical
    data (2008-2019) is already in year-type-county.csv, and years 2020+ have
    victim type data in the per-crash XML files.
    """
    err("refresh_summaries: skipping (PDFs no longer available after NJSP site migration)")
    return None
