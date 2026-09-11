from os import remove, stat
from os.path import exists

import pandas as pd
from typing import Tuple, Optional

import sqlite3

from nj_crashes.utils.log import err


def add_idx(cur, tbl, *cols):
    name = '_'.join(cols)
    return cur.execute(f"CREATE INDEX {name} ON {tbl}({', '.join(cols)})")


def make_pk(cur, tbl: str, pk: str):
    """Rebuild `tbl` so `pk` is `INTEGER PRIMARY KEY` (the rowid).

    `DataFrame.to_sql` can't declare a primary key and, for a named index,
    auto-creates a redundant `ix_<tbl>_<pk>` index. Making `pk` the rowid drops
    that index (a real D1 rows-written cost — each index row is billed) and gives
    O(1) id lookups. No-op if `pk` isn't a column.
    """
    cols = [(r[1], r[2]) for r in cur.execute(f'PRAGMA table_info("{tbl}")')]  # (name, type)
    if pk not in {c for c, _ in cols}:
        return
    coldefs = ', '.join(
        f'"{name}" INTEGER PRIMARY KEY' if name == pk else f'"{name}" {typ}'.rstrip()
        for name, typ in cols
    )
    collist = ', '.join(f'"{c}"' for c, _ in cols)
    cur.execute(f'DROP TABLE IF EXISTS "{tbl}__old"')  # defensive: no stale temp
    cur.execute(f'ALTER TABLE "{tbl}" RENAME TO "{tbl}__old"')
    cur.execute(f'CREATE TABLE "{tbl}" ({coldefs})')  # drops the pandas ix_<tbl>_<pk>
    cur.execute(f'INSERT INTO "{tbl}" ({collist}) SELECT {collist} FROM "{tbl}__old"')
    cur.execute(f'DROP TABLE "{tbl}__old"')


def del_idx(cur, *cols):
    name = '_'.join(cols)
    return cur.execute(f"DROP INDEX {name}")


def exec(cur, sql: str):
    err(sql)
    return cur.execute(sql)


def add_fk(cur, tbl, col, ref_tbl, ref_col):
    col2 = f"{col}2"
    exec(cur, f'ALTER TABLE {tbl} ADD COLUMN {col2} REFERENCES {ref_tbl}({ref_col})')
    exec(cur, f'UPDATE {tbl} SET {col2} = {col}')
    exec(cur, f'ALTER TABLE {tbl} DROP COLUMN {col}')
    exec(cur, f'ALTER TABLE {tbl} RENAME COLUMN {col2} TO {col}')
    exec(cur, f'CREATE INDEX {tbl}_{col} ON {tbl}({col})')


def resize(cur, page_size: int, db_path: str = None):
    cur.execute("pragma journal_mode = delete")
    cur.execute(f"pragma page_size = {page_size}")
    cur.execute("vacuum")
    err(f"After setting page_size={page_size} and vacuum: {stat(db_path).st_size} bytes")


def write(
        df: pd.DataFrame,
        tbl: str,
        db_path: str,
        idxs: list[Tuple[str]] = None,
        pk: Optional[str] = None,
        rm: bool = False,
        replace: bool = True,
        page_size: Optional[int] = None,
):
    if rm and exists(db_path):
        err(f"Removing {db_path}")
        remove(db_path)

    err(f"Writing {len(df)} rows to {db_path} ({tbl})")
    kwargs = dict(if_exists='replace') if replace else dict()
    df.to_sql(tbl, f'sqlite:///{db_path}', **kwargs)
    err(f"Wrote DB: {stat(db_path).st_size} bytes")
    with sqlite3.connect(db_path) as con:
        cur = con.cursor()
        if pk:
            make_pk(cur, tbl, pk)
        if idxs:
            for idx_cols in idxs:
                add_idx(cur, tbl, *idx_cols)
            err(f"After indices: {stat(db_path).st_size} bytes")

        # VACUUM (in resize) cannot run inside a transaction; make_pk's INSERT
        # leaves one open, so commit the schema/index work first.
        con.commit()
        if page_size:
            resize(cur, page_size, db_path)
