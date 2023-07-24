from njsp.cli.base import njsp
from .refresh_data import refresh_data
from .update_pqts import update_pqts
from .update_plots import update_plots
from .slack import slack, commit, sync


def main():
    njsp()


if __name__ == '__main__':
    main()
