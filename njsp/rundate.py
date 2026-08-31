import json
import pandas as pd
from functools import cached_property, partial

from nj_crashes.utils import git, TZ
from njsp.paths import RUNDATE_PATH, RUNDATE_RELPATH, OLD_RUNDATE_RELPATH


def year_dt(year, tz):
    return pd.to_datetime(f'{year}').tz_localize(tz)


RELPATHS = [ RUNDATE_RELPATH, OLD_RUNDATE_RELPATH ]
blob_from_commit = partial(git.blob_from_commit, relpaths=RELPATHS)


class Rundate:
    def __init__(self, cur=None):
        # `cur=None` reads `rundate.json` (the raw NJSP feed timestamp, which
        # advances on every refresh — even a no-op one). Pass an explicit
        # timestamp to anchor a `Rundate` to a *data-derived* instant instead
        # (e.g. `crash-log.parquet`'s latest event), so downstream year/fraction
        # math is a pure function of the data, not the wall clock.
        self._cur = cur

    @cached_property
    def cur(self):
        if self._cur is not None:
            dt = pd.to_datetime(self._cur)
            return dt if dt.tz else dt.tz_localize(TZ)
        with open(RUNDATE_PATH, 'r') as f:
            dt = pd.to_datetime(json.load(f)['rundate'])
            return dt if dt.tz else dt.tz_localize(TZ)

    @property
    def cur_month_str(self):
        return self.strftime('%Y-%m')

    @property
    def cur_month_dt(self):
        return pd.to_datetime(self.cur_month_str).tz_localize(self.tz)

    @property
    def prv_year_dt(self):
        return year_dt(self.year - 1, self.tz)

    @property
    def cur_year_dt(self):
        return year_dt(self.year, self.tz)

    @property
    def nxt_year_dt(self):
        return year_dt(self.year + 1, self.tz)

    def __getattr__(self, attr):
        return getattr(self.cur, attr)

    def __str__(self):
        return str(self.cur)
