import lazy_loader as lazy

__getattr__, __dir__, __all__ = lazy.attach(
    __name__,
    submodules=['paths', 'rundate', 'ytd'],
    submod_attrs={
        'rundate': ['Rundate'],
        'ytd': ['Ytd'],
        'commit_crashes': ['CommitCrashes', 'DEFAULT_ROOT_SHA'],
        'crash_log': ['get_crash_log'],
        'fauqstats': ['FAUQStats'],
    },
)
