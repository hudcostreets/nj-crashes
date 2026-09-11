"""Schema of the crashes/child D1 source DBs: `id` is the PK (rowid), and only the
intended indexes exist — the pandas `ix_<tbl>_id` auto-index is gone (a billed D1
write per row). See `sql.make_pk` / `write_db(pk='id')` and `CRASH_IDXS`.
"""
import sqlite3
import tempfile
from pathlib import Path

import pandas as pd

from nj_crashes.utils import sql
from njdot.load import CRASH_IDXS


def _crashes_df():
    # id as the (named) index, like `read_parquet` yields for these tables.
    return pd.DataFrame(
        {"cc": [11, 11, 3], "mc": [14, 14, 1], "severity": ["f", "i", "p"],
         "dt": ["2020-01-01", "2021-02-02", "2022-03-03"], "ilat": [40.3, 40.4, 39.9]},
        index=pd.Index([100, 101, 102], name="id"),
    )


def _introspect(db_path, tbl):
    con = sqlite3.connect(db_path)
    try:
        # (name, type, pk-position) per column
        cols = {r[1]: (r[2], r[5]) for r in con.execute(f'PRAGMA table_info("{tbl}")')}
        indexes = sorted(r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"))
        if "id" not in cols:
            return cols, indexes, None, None
        rowid_eq_id = con.execute(f'SELECT count(*) FROM "{tbl}" WHERE rowid != id').fetchone()[0]
        ids = [r[0] for r in con.execute(f'SELECT id FROM "{tbl}" ORDER BY id')]
        return cols, indexes, rowid_eq_id, ids
    finally:
        con.close()


def test_crashes_id_is_pk_and_only_two_indexes():
    with tempfile.TemporaryDirectory() as d:
        db = str(Path(d) / "crashes.db")
        # page_size triggers VACUUM after make_pk; VACUUM can't run inside a
        # transaction, so this guards the "commit before VACUUM" ordering (a
        # regression here silently left the table empty + a stale crashes__old).
        sql.write(df=_crashes_df(), tbl="crashes", db_path=db, idxs=CRASH_IDXS, pk="id",
                  rm=True, replace=True, page_size=2 ** 16)
        cols, indexes, rowid_neq_id, ids = _introspect(db, "crashes")

        assert cols["id"] == ("INTEGER", 1)                 # INTEGER PRIMARY KEY (rowid)
        assert indexes == ["cc_mc_severity_dt", "dt_severity"]  # no ix_crashes_id
        assert rowid_neq_id == 0                              # id IS the rowid
        assert ids == [100, 101, 102]                        # rows preserved (VACUUM committed)
        # no lingering temp table from make_pk's rebuild
        con = sqlite3.connect(db)
        tables = sorted(r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
        con.close()
        assert tables == ["crashes"]


def test_child_table_keeps_crash_id_drops_id_index():
    df = pd.DataFrame(
        {"crash_id": [100, 100, 101], "vn": [1, 2, 1]},
        index=pd.Index([1, 2, 3], name="id"),
    )
    with tempfile.TemporaryDirectory() as d:
        db = str(Path(d) / "vehicles.db")
        sql.write(df=df, tbl="vehicles", db_path=db, idxs=[("crash_id",)], pk="id",
                  rm=True, replace=True)
        cols, indexes, rowid_neq_id, ids = _introspect(db, "vehicles")

        assert cols["id"] == ("INTEGER", 1)
        assert indexes == ["crash_id"]                       # no ix_vehicles_id
        assert rowid_neq_id == 0
        assert ids == [1, 2, 3]


def test_make_pk_is_noop_without_the_column():
    # A frame whose index isn't `id`: make_pk('id') must leave the table intact.
    df = pd.DataFrame({"a": [1, 2]}, index=pd.Index([0, 1], name="idx"))
    with tempfile.TemporaryDirectory() as d:
        db = str(Path(d) / "t.db")
        sql.write(df=df, tbl="t", db_path=db, pk="id", rm=True, replace=True)
        cols, indexes, _, _ = _introspect(db, "t")
        assert sorted(cols) == ["a", "idx"]   # untouched: no `id`, no PK forced
