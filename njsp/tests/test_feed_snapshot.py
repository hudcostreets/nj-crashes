"""Tests for `njsp.crash_log.feed_snapshot` — reconstructing the NJSP feed's
point-in-time view from `crash-log.parquet`, replacing the git-history walk."""
from os.path import exists

import pandas as pd
import pytest

from njsp.crash_log import FAUQSTATS_COLS, feed_snapshot
from njsp.paths import CRASH_LOG_PQT
from njsp.ytc import to_ytc

TZ = "US/Eastern"


def _event(accid, sha, rundate, kind, dt, fatalities=1):
    row = {col: None for col in FAUQSTATS_COLS}
    row.update(
        accid=accid, sha=sha,
        rundate=pd.Timestamp(rundate, tz=TZ),
        kind=kind,
        dt=pd.Timestamp(dt, tz=TZ),
        CCODE="09", CNAME="Hudson", MCODE="0906", MNAME="Jersey City",
        FATALITIES=float(fatalities),
        FATAL_D=float(fatalities),
    )
    return row


# Three feed rundates: r1=2024-02-15, r2=2024-04-20, r3=2024-06-10.
SYNTHETIC = pd.DataFrame([
    _event(1, "a1", "2024-02-15", "add", "2024-03-01"),
    _event(2, "a1", "2024-02-15", "add", "2024-04-01", fatalities=1),
    _event(2, "c3", "2024-06-10", "update", "2024-04-01", fatalities=2),
    _event(3, "b2", "2024-04-20", "add", "2024-05-01"),
    _event(3, "c3", "2024-06-10", "del", "2024-05-01"),
    _event(4, "c3", "2024-06-10", "add", "2024-06-01"),
    _event(5, "a1", "2024-02-15", "add", "2023-12-01"),  # prior-year crash
]).set_index(["accid", "sha"])


def test_feed_snapshot_snaps_as_of_forward_and_replays_adds():
    # as_of snaps forward to r2 — the first rundate on or after 2024-03-01.
    snap = feed_snapshot(2024, "2024-03-01", crash_log=SYNTHETIC)
    assert snap.rundate == pd.Timestamp("2024-04-20", tz=TZ)
    # accid 4 (added at r3) not yet present; accid 3 (deleted at r3) still
    # present; accid 5 excluded (2023 crash, not 2024).
    assert sorted(snap.crashes.index) == [1, 2, 3]
    assert int(snap.crashes.loc[2, "FATALITIES"]) == 1  # pre-update value


def test_feed_snapshot_applies_updates_and_deletes():
    snap = feed_snapshot(2024, "2024-06-10", crash_log=SYNTHETIC)
    assert snap.rundate == pd.Timestamp("2024-06-10", tz=TZ)
    # accid 3 deleted at r3 -> absent; accid 4 added at r3 -> present.
    assert sorted(snap.crashes.index) == [1, 2, 4]
    assert int(snap.crashes.loc[2, "FATALITIES"]) == 2  # update is now in effect


def test_feed_snapshot_rejects_out_of_range_as_of():
    with pytest.raises(ValueError, match="crash-log starts at"):
        feed_snapshot(2024, "2024-01-01", crash_log=SYNTHETIC)
    with pytest.raises(ValueError, match="no rundate >="):
        feed_snapshot(2024, "2024-07-01", crash_log=SYNTHETIC)


@pytest.mark.skipif(not exists(CRASH_LOG_PQT), reason="crash-log.parquet not present")
def test_feed_snapshot_golden_2025_05_21():
    """Golden values cross-checked against the old git-history walk
    (`oldest_commit_rundate_since` + `FAUQStats.load`) — the projection's 2026
    prev-year input. Events at or before this rundate are append-only history,
    so these values are frozen."""
    snap = feed_snapshot(2025, "2025-05-21")
    assert snap.rundate == pd.Timestamp("2025-05-21 10:00:05", tz=TZ)
    assert len(snap.crashes) == 181
    assert int(snap.crashes.FATALITIES.sum()) == 196
    ytc = to_ytc(snap.crashes)
    totals = ytc[["driver", "passenger", "pedestrian", "cyclist", "crashes"]].sum()
    assert {k: int(v) for k, v in totals.items()} == {
        "driver": 103, "passenger": 33, "pedestrian": 54, "cyclist": 6, "crashes": 181,
    }


# ── Trailing-365 windowing — Phase 2A ──────────────────────────────────────
#
# `Ytd.trailing_365_crashes` calls `feed_snapshot(prv_year, rundate)` +
# `feed_snapshot(cur_year, rundate)` and filters dt to `[rundate-365d, rundate]`.
# These tests cover that compose: replay correctness via `feed_snapshot` (tested
# above) + the dt-window filter on top.

# Synthetic crash-log spanning two years for trailing-window tests. Three
# rundates: 2024-03-15 (early), 2024-09-15 (mid), 2025-03-15 (cross-year).
TRAILING_SYNTHETIC = pd.DataFrame([
    _event(10, "r1", "2024-03-15", "add", "2024-03-10"),     # in window from any 2024-03+ rundate
    _event(11, "r1", "2024-03-15", "add", "2023-04-10"),     # 11mo+ before 2025-03-15 — in window
    _event(12, "r1", "2024-03-15", "add", "2023-02-10"),     # 13mo before 2025-03-15 — OUT
    _event(13, "r2", "2024-09-15", "add", "2024-09-10"),     # added at r2
    _event(14, "r3", "2025-03-15", "add", "2025-03-01"),     # added at r3
    _event(15, "r1", "2024-03-15", "add", "2024-01-01"),     # in window from 2024-09 rundate
    _event(15, "r3", "2025-03-15", "del", "2024-01-01"),     # …but deleted by r3
]).set_index(["accid", "sha"])


def _trailing_window(crash_log, prv_year, cur_year, rundate):
    """Mirror `Ytd.trailing_365_crashes` for testing — same compose pattern."""
    rundate_ts = pd.Timestamp(rundate, tz=TZ)
    window_start = rundate_ts - pd.Timedelta(days=365)
    cur = feed_snapshot(cur_year, rundate_ts, crash_log=crash_log).crashes
    prv = feed_snapshot(prv_year, rundate_ts, crash_log=crash_log).crashes
    crashes = pd.concat([prv, cur])
    return crashes[(crashes.dt >= window_start) & (crashes.dt <= rundate_ts)]


def test_trailing_365_window_filters_by_dt():
    # At r1 (2024-03-15), window = [2023-03-16, 2024-03-15]:
    #   10 (2024-03-10) IN; 11 (2023-04-10) IN; 12 (2023-02-10) OUT (~1mo before
    #   window start); 13/14 not yet added; 15 (2024-01-01) IN.
    out = _trailing_window(TRAILING_SYNTHETIC, prv_year=2023, cur_year=2024, rundate="2024-03-15")
    assert sorted(out.index) == [10, 11, 15]


def test_trailing_365_window_spans_calendar_boundary():
    # Window = [2024-03-16, 2025-03-15]. accid 13 (2024-09-10) IN, 14 (2025-03-01) IN.
    # accid 15 was added 2024-01-01 (OUT of window) then del'd at r3 anyway.
    # accid 11 (2023-04-10) is OUT of window.
    out = _trailing_window(TRAILING_SYNTHETIC, prv_year=2024, cur_year=2025, rundate="2025-03-15")
    assert sorted(out.index) == [13, 14]


def test_trailing_365_window_at_earlier_rundate_sees_no_2025():
    # At r2 (2024-09-15), no 2025 crashes yet exist in the crash-log. Window
    # = [2023-09-16, 2024-09-15] — 11 (2023-04-10) OUT, 15 (2024-01-01) IN,
    # 13 (2024-09-10) IN, 10 (2024-03-10) IN.
    out = _trailing_window(TRAILING_SYNTHETIC, prv_year=2023, cur_year=2024, rundate="2024-09-15")
    assert sorted(out.index) == [10, 13, 15]
