# Lazy imports - heavy modules are only loaded when accessed
def __getattr__(name):
    if name == 'paths':
        from . import paths
        return paths
    elif name == 'rundate':
        from . import rundate
        return rundate
    elif name == 'ytd':
        from . import ytd
        return ytd
    elif name == 'Rundate':
        from .rundate import Rundate
        return Rundate
    elif name == 'Ytd':
        from .ytd import Ytd
        return Ytd
    elif name == 'CommitCrashes':
        from .commit_crashes import CommitCrashes
        return CommitCrashes
    elif name == 'DEFAULT_ROOT_SHA':
        from .commit_crashes import DEFAULT_ROOT_SHA
        return DEFAULT_ROOT_SHA
    elif name == 'get_crash_log':
        from .crash_log import get_crash_log
        return get_crash_log
    elif name == 'FAUQStats':
        from .fauqstats import FAUQStats
        return FAUQStats
    raise AttributeError(f"module 'njsp' has no attribute {name!r}")
