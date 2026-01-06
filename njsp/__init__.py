# Lazy imports - heavy modules are only loaded when accessed
import importlib
import sys

_module = sys.modules[__name__]

def __getattr__(name):
    if name == 'paths':
        mod = importlib.import_module('.paths', __name__)
        setattr(_module, 'paths', mod)
        return mod
    elif name == 'rundate':
        mod = importlib.import_module('.rundate', __name__)
        setattr(_module, 'rundate', mod)
        return mod
    elif name == 'ytd':
        mod = importlib.import_module('.ytd', __name__)
        setattr(_module, 'ytd', mod)
        return mod
    elif name == 'Rundate':
        from .rundate import Rundate
        setattr(_module, 'Rundate', Rundate)
        return Rundate
    elif name == 'Ytd':
        from .ytd import Ytd
        setattr(_module, 'Ytd', Ytd)
        return Ytd
    elif name == 'CommitCrashes':
        from .commit_crashes import CommitCrashes
        setattr(_module, 'CommitCrashes', CommitCrashes)
        return CommitCrashes
    elif name == 'DEFAULT_ROOT_SHA':
        from .commit_crashes import DEFAULT_ROOT_SHA
        setattr(_module, 'DEFAULT_ROOT_SHA', DEFAULT_ROOT_SHA)
        return DEFAULT_ROOT_SHA
    elif name == 'get_crash_log':
        from .crash_log import get_crash_log
        setattr(_module, 'get_crash_log', get_crash_log)
        return get_crash_log
    elif name == 'FAUQStats':
        from .fauqstats import FAUQStats
        setattr(_module, 'FAUQStats', FAUQStats)
        return FAUQStats
    raise AttributeError(f"module 'njsp' has no attribute {name!r}")
