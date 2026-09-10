"""Tests for `_apply_geocode_backfill` — the NJSP-milepost geocode sidecar
merge in `njdot/load.py`.

The backfill fills `(sri, mp, ilat, ilon)` on fatal crashes NJDOT failed to
geocode. It must join on `id` (the canonical unique crash key), NOT the
4-field PK `(year, cc, mc, case)`, which is non-unique: the 50 Princeton
Boro/Twp collision pairs share it (see CLAUDE.md). A 4-field join would (a)
apply one crash's recovered geocode to *both* members of a collision pair,
and (b) multiply `df` rows outright if the backfill ever carried a duplicate
key — the same PK-join hazard that produced the victim-count −210k bug.
"""
import pandas as pd
import pytest
from numpy import nan

from njdot.load import _apply_geocode_backfill


def _crashes():
    """3 crashes; the first two are a Princeton collision pair — identical
    `(year, cc, mc, case)`, distinct `id` — with no geocode yet."""
    return pd.DataFrame({
        'id':   [100, 200, 300],
        'year': [2015, 2015, 2016],
        'cc':   [11, 11, 5],
        'mc':   [14, 14, 2],
        'case': ['15-26624', '15-26624', '16-0001'],
        'sri':  pd.Series([nan, nan, nan], dtype=object),  # object, as in crashes.parquet
        'mp':   [nan, nan, nan],
        'ilat': [nan, nan, nan],
        'ilon': [nan, nan, nan],
    })


def _backfill_for_id(crash_id):
    return pd.DataFrame({
        'id':   [crash_id],
        'year': [2015], 'cc': [11], 'mc': [14], 'case': ['15-26624'],
        'sri':  ['02191121__'], 'mp': [0.7], 'ilat': [40.8], 'ilon': [-73.9],
        'geocode_source': ['njsp_mp'],
    })


def test_id_join_fills_only_the_matching_collision_member():
    """With `id` present, the geocode lands on exactly crash 100 — the
    Princeton twin (200) that shares the 4-field PK stays untouched."""
    out = _apply_geocode_backfill(_crashes(), _backfill_for_id(100)).set_index('id')
    assert out.loc[100, ['sri', 'mp', 'ilat', 'ilon']].tolist() == ['02191121__', 0.7, 40.8, -73.9]
    assert out.loc[200, ['sri', 'mp', 'ilat', 'ilon']].isna().tolist() == [True, True, True, True]
    assert out.loc[300, ['sri', 'mp', 'ilat', 'ilon']].isna().tolist() == [True, True, True, True]


def test_row_count_preserved():
    out = _apply_geocode_backfill(_crashes(), _backfill_for_id(100))
    assert len(out) == 3
    assert out['id'].tolist() == [100, 200, 300]


def test_existing_geocode_preserved_not_overwritten():
    df = _crashes()
    df.loc[df['id'] == 100, ['sri', 'mp', 'ilat', 'ilon']] = ['orig__', 1.1, 41.0, -74.0]
    out = _apply_geocode_backfill(df, _backfill_for_id(100)).set_index('id')
    assert out.loc[100, ['sri', 'mp', 'ilat', 'ilon']].tolist() == ['orig__', 1.1, 41.0, -74.0]


def test_duplicate_backfill_key_raises():
    """A duplicate join key on the backfill side would multiply matching
    crash rows — the guard must reject it loudly."""
    bf_dup = pd.concat([_backfill_for_id(100), _backfill_for_id(100)], ignore_index=True)
    with pytest.raises(AssertionError, match=r'duplicate.*key'):
        _apply_geocode_backfill(_crashes(), bf_dup)


def test_four_field_fallback_fills_both_collision_members():
    """Without `id` on both sides, the join falls back to the 4-field PK —
    which fills *both* Princeton twins (the exact defect id-join fixes). It
    still must not multiply rows. This documents why `id` is required."""
    df = _crashes().drop(columns=['id'])
    bf = _backfill_for_id(100).drop(columns=['id'])
    out = _apply_geocode_backfill(df, bf)
    assert len(out) == 3
    collision = out[out['case'] == '15-26624']
    assert collision['ilat'].tolist() == [40.8, 40.8]
