from juq.cli import write_nb
from juq.papermill.run import papermill_run

from njsp.cli.base import command


@command
def update_cmymc():
    """Update county/muni/year/month crash aggregation databases."""
    nb_path = 'njdot/cmymc.ipynb'
    nb, exc = papermill_run(nb_path)
    write_nb(nb, nb_path)
    if exc:
        raise exc
    return "Update CMYMC databases"
