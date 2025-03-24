from typing import Callable, Literal

from pandas import Timestamp

Dst = Literal['slack', 'markdown']
Fmt = Callable[[Timestamp], str] | str


def mk_dt_str(
    dt: Timestamp,
    fmt: Fmt,
) -> str:
    if callable(fmt):
        return fmt(dt)
    else:
        return dt.strftime(fmt)
