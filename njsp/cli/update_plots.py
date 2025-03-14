#!/usr/bin/env python
import click

from nj_crashes.utils.nb import execute
from njsp.cli.base import command


@command
@click.option('-k', '--kernel', default='python3')
def update_plots(kernel):
    """Regenerate plots based on latest NJSP data."""
    execute('njsp/update-plots.ipynb', kernel=kernel, parameters=dict(show='png'))
    return "Update NJSP plots"
