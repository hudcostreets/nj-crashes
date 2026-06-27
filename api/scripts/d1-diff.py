#!/usr/bin/env python3
"""Compute exact-diff DELETE+INSERT SQL for one table between two SQLite DBs."""
import argparse
import sqlite3
import sys
from pathlib import Path


DELETE_BATCH = 500
INSERT_BATCH = 200


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, bytes):
        return "X'" + v.hex() + "'"
    s = str(v).replace("'", "''")
    return f"'{s}'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--curr", required=True)
    ap.add_argument("--prior", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--pk", required=True, help="comma-separated natural-key columns")
    ap.add_argument("--out-delete", required=True)
    ap.add_argument("--out-upsert", required=True)
    args = ap.parse_args()

    table = args.table
    pk_cols = [c.strip() for c in args.pk.split(",") if c.strip()]
    if not pk_cols:
        print(f"d1-diff: no PK columns for {table}", file=sys.stderr)
        sys.exit(2)

    conn = sqlite3.connect(args.curr)
    conn.execute(f"ATTACH DATABASE '{args.prior}' AS prior")

    cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
    if not cols:
        print(f"d1-diff: table {table} not in curr", file=sys.stderr)
        sys.exit(2)

    pk_list = ", ".join(f'"{c}"' for c in pk_cols)
    all_cols = ", ".join(f'"{c}"' for c in cols)

    # Upsert: rows in curr but not prior (by full content)
    upsert_rows = list(conn.execute(
        f'SELECT {all_cols} FROM main."{table}" '
        f'EXCEPT SELECT {all_cols} FROM prior."{table}"'
    ))

    # Delete PKs: cleanly-removed rows (PK in prior, not in curr) plus
    # content-changed rows (PK in BOTH prior and an upsert row). Pure adds
    # — PK only in curr — need no DELETE, so don't include them.
    prior_pks = set(conn.execute(f'SELECT {pk_list} FROM prior."{table}"'))
    delete_pks = set(conn.execute(
        f'SELECT {pk_list} FROM prior."{table}" '
        f'EXCEPT SELECT {pk_list} FROM main."{table}"'
    ))
    pk_indices = [cols.index(c) for c in pk_cols]
    for row in upsert_rows:
        pk_tuple = tuple(row[i] for i in pk_indices)
        if pk_tuple in prior_pks:
            delete_pks.add(pk_tuple)

    conn.close()

    out_del = Path(args.out_delete)
    out_ins = Path(args.out_upsert)
    out_del.parent.mkdir(parents=True, exist_ok=True)
    out_ins.parent.mkdir(parents=True, exist_ok=True)

    with out_del.open("w") as f:
        if delete_pks:
            pk_tuples = sorted(delete_pks)
            for i in range(0, len(pk_tuples), DELETE_BATCH):
                chunk = pk_tuples[i:i + DELETE_BATCH]
                vals = ",".join(
                    "(" + ",".join(sql_literal(v) for v in t) + ")" for t in chunk
                )
                f.write(f'DELETE FROM "{table}" WHERE ({pk_list}) IN ({vals});\n')

    with out_ins.open("w") as f:
        if upsert_rows:
            for i in range(0, len(upsert_rows), INSERT_BATCH):
                chunk = upsert_rows[i:i + INSERT_BATCH]
                vals = ",".join(
                    "(" + ",".join(sql_literal(v) for v in r) + ")" for r in chunk
                )
                f.write(f'INSERT INTO "{table}" ({all_cols}) VALUES {vals};\n')

    print(f"d1-diff {table}: delete={len(delete_pks)} upsert={len(upsert_rows)}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
