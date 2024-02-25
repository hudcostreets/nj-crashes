from njsp.cli.base import njsp
from .refresh_data import refresh_data
from .harmonize_muni_codes import harmonize_muni_codes
from .update_pqts import update_pqts
from .refresh_summaries import refresh_summaries
from .update_projections import update_projections
from .update_plots import update_plots
from .slack import slack, sync
from .crash_log import crash_log


def main():
    njsp()


if __name__ == '__main__':
    main()
