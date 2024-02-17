from os import remove, stat
from os.path import exists

import pandas as pd
from typing import Tuple, Optional

import sqlite3

from nj_crashes.utils.log import err


def add_idx(cur, tbl, *cols):
    name = '_'.join(cols)
    return cur.execute(f"CREATE INDEX {name} ON {tbl}({', '.join(cols)})")


def del_idx(cur, *cols):
    name = '_'.join(cols)
    return cur.execute(f"DROP INDEX {name}")


def write(
        df: pd.DataFrame,
        tbl: str,
        db_path: str,
        idxs: list[Tuple[str]] = None,
        rm: bool = False,
        replace: bool = True,
        page_size: Optional[int] = None,
):
    if rm and exists(db_path):
        err(f"Removing {db_path}")
        remove(db_path)

    err(f"Writing {len(df)} rows to {db_path}")
    kwargs = dict(if_exists='replace') if replace else dict()
    df.to_sql(tbl, f'sqlite:///{db_path}', **kwargs)
    err(f"Wrote DB: {stat(db_path).st_size} bytes")
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    if idxs:
        for idx_cols in idxs:
            add_idx(cur, tbl, *idx_cols)
        err(f"After indices: {stat(db_path).st_size} bytes")

    if page_size:
        cur.execute("pragma journal_mode = delete")
        cur.execute(f"pragma page_size = {page_size}")
        cur.execute("vacuum")
        err(f"After setting page_size={page_size} and vacuum: {stat(db_path).st_size} bytes")

    return cur
