"""The child→crash join keys on the crash's RAW `mc_dot`, so a child carrying its
raw `mc` matches even when the crash was geocoded (mc != mc_dot).

Regression guard for the 2026 v2 `crash_pk_mappings` remap that overwrote the child
`mc` with the *geocoded* value before this raw-`mc_dot` join, silently orphaning
~18% of children (every geocoded crash). See njdot/{occupants,vehicles,pedestrians}.py.
"""
import pandas as pd

from njdot.load import normalize


def _fake_crashes(cols=None):
    # One geocoded crash: raw code mc_dot=9 (e.g. Princeton Boro), geocoded mc=14.
    df = pd.DataFrame(
        {"year": [2012], "cc": [11], "mc": [14], "mc_dot": [9], "case": ["X"]},
        index=pd.Index([500], name="id"),
    )
    return df[cols] if cols else df


def test_child_with_raw_mc_matches_geocoded_crash():
    # Post-fix: the child keeps its raw mc (=9), which equals the crash's mc_dot.
    child = pd.DataFrame({"year": [2012], "cc": [11], "mc": [9], "case": ["X"], "age": [30]})
    out = normalize(child, "crash_id", _fake_crashes)
    assert out["crash_id"].tolist() == [500]     # matched, not orphaned
    assert out["age"].tolist() == [30]           # payload preserved


def test_geocoded_child_mc_orphans():
    # The old bug: crash_pk_mappings set child mc → 14 (geocoded), which no longer
    # matches the raw mc_dot (=9) join, so the child is orphaned (crash_id is NA).
    child = pd.DataFrame({"year": [2012], "cc": [11], "mc": [14], "case": ["X"], "age": [30]})
    out = normalize(child, "crash_id", _fake_crashes)
    assert out["crash_id"].isna().all()
