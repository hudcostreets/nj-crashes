#!/usr/bin/env python
import click
from datetime import datetime
from os.path import exists

from nj_crashes.utils.nb import execute
from njsp.cli.base import command
from njsp.paths import fauqstats_relpath
from utz import err


@command
@click.option('-k', '--kernel', default='python3')
def update_projections(kernel):
    """Update projected rest-of-year fatalities based on latest NJSP data."""
    current_year = datetime.now().year
    fauqstats_path = fauqstats_relpath(current_year)
    if not exists(fauqstats_path):
        err(f"Skipping projections: {fauqstats_path} not found (current year data not yet available)")
        return None
    nb_path = 'njsp/update-projections.ipynb'
    execute(nb_path, kernel=kernel)
    return "Update NJSP projections"
