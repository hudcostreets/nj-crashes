from typing import Optional

import pandas as pd
from dateutil.parser import parse
from dateutil.tz import gettz


# Timezone info for EST/EDT (used in NJSP RUNDATE strings)
TZINFOS = {
    'EST': gettz('America/New_York'),
    'EDT': gettz('America/New_York'),
}


def parse_rundate(s: str):
    """Parse a RUNDATE string like 'Mon Jan 05 10:01:14 EST 2026'."""
    return parse(s, tzinfos=TZINFOS)


RED = '\033[31m'
GREEN = '\033[32m'
BLUE = '\033[34m'
YELLOW = '\033[33m'
ORANGE = '\033[38;5;214m'
RESET = '\033[0m'


def cur_year():
    return pd.to_datetime('now', utc=True).year


def parse_years(years: str, start: int, end: Optional[int] = None) -> list[int]:
    if end is None:
        end = cur_year()

    if isinstance(years, str):
        pcs = years.split(':')
        if len(pcs) == 1:
            years = [ int(years) ]
        elif len(pcs) == 2:
            start = int(pcs[0]) if pcs[0] else start
            end = int(pcs[1]) if pcs[1] else end
            years = list(range(start, end))
        else:
            raise ValueError(f"Unrecognized `years`: {years}")
    elif isinstance(years, int):
        years = [years]
    elif isinstance(years, (list, tuple)):
        years = [ int(year) for year in years ]
    else:
        raise ValueError(f"Unrecognized `years`: {years}")

    return years
