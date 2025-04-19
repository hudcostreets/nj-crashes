from typing import Callable

import utz

Log = Callable[[str], None]


class SilentLog:
    def __call__(self, msg: str):
        pass

    def __bool__(self):
        return False


none = SilentLog()


def err(msg):
    utz.err(str(msg))
