from typing import Callable

import utz

Log = Callable[[str], None]


def none(msg: str):
    pass


def err(msg):
    utz.err(str(msg))
