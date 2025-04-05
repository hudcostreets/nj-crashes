from typing import Callable

from pandas import Timestamp

Fmt = Callable[[Timestamp], str] | str


def mk_dt_str(
    dt: Timestamp,
    fmt: Fmt,
) -> str:
    if callable(fmt):
        return fmt(dt)
    else:
        return dt.strftime(fmt)
