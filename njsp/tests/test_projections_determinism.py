"""Projections must be a pure function of their data inputs, not the wall clock.

`Ytd` anchors its "current rundate" to `crash-log.parquet`'s latest *event*
rundate rather than to `rundate.json` (the raw NJSP feed timestamp, which
advances on every daily refresh — even a no-op one, and which a from-scratch
reproc doesn't rebuild). Before this, `Ytd.rundate` read `rundate.json`, so
`feed_snapshot(as_of=rundate.json)` would raise ``no rundate >= …`` whenever the
feed timestamp ran ahead of the crash-log's newest content (routine on the daily,
guaranteed in a reproc), and the projection drifted day-to-day on no-op refreshes.
"""
import pandas as pd

from nj_crashes.utils import TZ
from njsp.rundate import Rundate
from njsp.ytd import Ytd


def _crash_log(rundates):
    """Minimal crash-log frame — only the `rundate` column drives anchoring."""
    return pd.DataFrame({
        'accid': range(len(rundates)),
        'rundate': [pd.Timestamp(r, tz=TZ) for r in rundates],
    })


def test_rundate_explicit_overrides_file():
    ts = pd.Timestamp("2024-06-10 10:00:00", tz=TZ)
    assert Rundate(cur=ts).cur == ts


def test_rundate_explicit_naive_is_tz_localized():
    r = Rundate(cur="2024-06-10")
    assert r.cur == pd.Timestamp("2024-06-10", tz=TZ)
    assert r.year == 2024


def test_ytd_rundate_anchors_to_crash_log_max():
    ytd = Ytd()
    # Pre-seed the `crash_log` cached_property so no parquet is read. Latest
    # event is 2026-08-25, deliberately *out of order* to prove `.max()` is used.
    ytd.__dict__['crash_log'] = _crash_log(["2026-08-20", "2026-08-25", "2026-08-22"])
    assert ytd.rundate.cur == pd.Timestamp("2026-08-25", tz=TZ)
    assert ytd.cur_year == 2026
    assert ytd.prv_year == 2025
    # Fraction of 2026 elapsed at 2026-08-25, computed the way the property does
    # (tz-aware, so the EST→EDT hour is accounted for), not a naive day ratio.
    y0, as_of, y1 = (pd.Timestamp(t, tz=TZ) for t in ("2026", "2026-08-25", "2027"))
    assert ytd.cur_year_frac == (as_of - y0) / (y1 - y0)
