"""Regression test for `compute_victim_counts`' denormalized-PK join.

Crashes are geocoded in `rawdata/pqt.py` (Port Authority + empty-muni fixes),
which can move `(cc, mc)` away from the preserved raw `(cc0, mc0)`. Occupant /
pedestrian records still carry the *original* `(cc, mc)`, so victim counts must
merge on the crash's `(cc0, mc0)`, not its geocoded `(cc, mc)`. Merging on the
geocoded key silently drops every geocoded crash's victims — measured at ~149k
crashes / -210k `ti` across the DOT history, and reproduced minimally here.

The fixture crash `GEO` was geocoded `mc 30 -> 31`; its two injured occupants
sit at the original `mc=30`. Pre-fix, the merge on `(year, cc, mc, case)` finds
no match and reports `ti=0`; post-fix (merge on `(year, cc0, mc0, case)`) it
recovers the real `ti=2`.
"""
import pandas as pd
import pytest

import njdot.load
from njdot.crashes import compute_victim_counts


def _crashes():
    """Two crashes: `GEO` was geocoded (mc 30->31); `SAME` was not (mc 20)."""
    df = pd.DataFrame([
        # id, year, cc, mc (geocoded), cc0, mc0 (original), case, tk0, ti0
        dict(id=1, year=2013, cc=15, mc=31, cc0=15, mc0=30, case='GEO',  tk0=0, ti0=2),
        dict(id=2, year=2013, cc=15, mc=20, cc0=15, mc0=20, case='SAME', tk0=0, ti0=1),
    ]).set_index('id')
    return df


def _victims_fixture(monkeypatch):
    """Patch `load_tbl` so `compute_victim_counts` sees fixed occupants/peds at
    the crashes' *original* `(cc, mc)`. `GEO` (geocoded mc 30->31): 2 injured
    occupants + 1 injured pedestrian, all at the original mc=30. `SAME`: 1
    injured occupant."""
    occs = pd.DataFrame([
        dict(year=2013, cc=15, mc=30, case='GEO',  condition=3, pos=1),  # driver, minor
        dict(year=2013, cc=15, mc=30, case='GEO',  condition=4, pos=2),  # passenger, possible
        dict(year=2013, cc=15, mc=20, case='SAME', condition=2, pos=1),  # driver, serious
    ])
    peds = pd.DataFrame([
        dict(year=2013, cc=15, mc=30, case='GEO', condition=3, cyclist=False),  # pedestrian, minor
    ])

    def fake_load_tbl(tbl, **kwargs):
        return {'occupants': occs, 'pedestrians': peds}[tbl].copy()

    monkeypatch.setattr(njdot.load, 'load_tbl', fake_load_tbl)


def test_victim_counts_align_to_pre_geocode_pk(monkeypatch):
    _victims_fixture(monkeypatch)
    out = compute_victim_counts(_crashes(), [2013]).sort_index()

    # Both crashes recover their true victim-record injury counts, including the
    # geocoded one whose victims live at the original mc=30. GEO: 2 occ + 1 ped
    # injured = ti 3, pi 1. SAME: 1 occ injured = ti 1, pi 0.
    assert out.loc[1, 'ti'] == 3, "geocoded crash must keep its victims' injuries"
    assert out['ti'].tolist() == [3, 1]
    assert out['pi'].tolist() == [1, 0]
    assert out['tk'].tolist() == [0, 0]


def test_missing_cc0_mc0_raises(monkeypatch):
    _victims_fixture(monkeypatch)
    df = _crashes().drop(columns=['cc0', 'mc0'])
    with pytest.raises(ValueError, match='cc0/mc0'):
        compute_victim_counts(df, [2013])
