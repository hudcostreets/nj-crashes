from os import remove
from os.path import exists

import pandas as pd
from typing import Tuple

import sqlite3

from nj_crashes.utils.log import err


def add_idx(cur, tbl, *cols):
    name = '_'.join(cols)
    return cur.execute(f"CREATE INDEX {name} ON {tbl}({', '.join(cols)})")


def del_idx(cur, *cols):
    name = '_'.join(cols)
    return cur.execute(f"DROP INDEX {name}")


def write(df: pd.DataFrame, tbl: str, db_path: str, idxs: list[Tuple[str]] = None, rm: bool = True):
    if rm and exists(db_path):
        err(f"Removing {db_path}")
        remove(db_path)

    err(f"Writing {len(df)} rows to {db_path}")
    df.to_sql(tbl, f'sqlite:///{db_path}')
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    if idxs:
        for idx_cols in idxs:
            add_idx(cur, tbl, *idx_cols)
    return cur
