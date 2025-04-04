from njsp.cli.base import njsp
from . import (
    refresh_data,
    harmonize_muni_codes,
    update_pqts,
    refresh_summaries,
    update_projections,
    update_plots,
    bsky,
    slack,
    crash_log,
)

def main():
    njsp()


if __name__ == '__main__':
    main()
