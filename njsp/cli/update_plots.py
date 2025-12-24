#!/usr/bin/env python
from juq.cli import write_nb
from juq.papermill.run import papermill_run

from njsp.cli.base import command


@command
def update_plots():
    """Regenerate plots based on latest NJSP data."""
    nb_path = 'njsp/update-plots.ipynb'
    nb, exc = papermill_run(nb_path, parameter_strs=('show=png',))
    write_nb(nb, nb_path)
    if exc:
        raise exc
    return "Update NJSP plots"
