from njdot.harmonize_muni_codes import main as harmonize_main
from njsp.cli.base import command


@command
def harmonize_muni_codes():
    """Harmonize NJDOT/NJSP/NJGIN muni codes; write `cc2mc2mn.json` and `muni_codes.parquet`s."""
    harmonize_main()
    return "Harmonize county/muni codes"
