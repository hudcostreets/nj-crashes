#!/usr/bin/env python
from datetime import datetime
from os.path import exists

from juq.cli import write_nb
from juq.papermill.run import papermill_run

from njsp.cli.base import command
from njsp.paths import fauqstats_relpath
from utz import err


@command
def update_projections():
    """Update projected rest-of-year fatalities based on latest NJSP data."""
    current_year = datetime.now().year
    fauqstats_path = fauqstats_relpath(current_year)
    if not exists(fauqstats_path):
        err(f"Skipping projections: {fauqstats_path} not found (current year data not yet available)")
        return None
    nb_path = 'njsp/update-projections.ipynb'
    nb, exc = papermill_run(nb_path)
    write_nb(nb, nb_path)
    if exc:
        raise exc
    return "Update NJSP projections"
