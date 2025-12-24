from njsp.cli.base import njsp
from . import (
    bsky,
    crash_log,
    harmonize_muni_codes,
    refresh_data,
    refresh_summaries,
    slack,
    update_cmymc,
    update_plots,
    update_pqts,
    update_projections,
)

def main():
    njsp()


if __name__ == '__main__':
    main()
