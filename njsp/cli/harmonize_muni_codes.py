from juq.cli import write_nb
from juq.papermill.run import papermill_run

from njsp.cli.base import command


@command
def harmonize_muni_codes():
    """Harmonize county/muni codes between NJDOT and NJSP, output cc2mc2mn.json"""
    nb_path = 'njdot/harmonize-muni-codes.ipynb'
    nb, exc = papermill_run(nb_path)
    write_nb(nb, nb_path)
    if exc:
        raise exc
    return "Harmonize county/muni codes"
