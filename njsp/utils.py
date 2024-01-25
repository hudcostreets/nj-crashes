from typing import Optional

import pandas as pd


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
