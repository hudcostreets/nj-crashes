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
