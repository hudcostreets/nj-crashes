from njsp.cli.base import njsp
from .refresh_data import refresh_data
from .refresh_summaries import refresh_summaries
from .update_pqts import update_pqts
from .update_plots import update_plots
from .update_projections import update_projections
from .slack import slack, sync


def main():
    njsp()


if __name__ == '__main__':
    main()
