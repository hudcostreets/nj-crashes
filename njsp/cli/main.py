from njsp.cli.base import njsp
from . import (
    refresh_data,
    harmonize_muni_codes,
    update_pqts,
    refresh_summaries,
    update_projections,
    update_plots,
    crash_log,
)

# Lazy import for optional bsky and slack dependencies
def __getattr__(name):
    if name == 'bsky':
        from . import bsky
        return bsky
    elif name == 'slack':
        from . import slack
        return slack
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

def main():
    # Import bsky and slack lazily when CLI is invoked
    # This allows their subcommands to be registered without requiring dependencies at import time
    try:
        from . import bsky, slack
    except ImportError:
        pass  # Optional dependencies not installed
    njsp()


if __name__ == '__main__':
    main()
