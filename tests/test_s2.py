"""S2 cell-math validation (see `specs/s2-pyramid.md`, `njdot/s2.py`).

Pins the two invariants the whole S2 pipeline rests on:

1. `s2sphere` (Python builder) produces the exact tokens the client's
   `nodes2ts` does — the golden strings below were emitted by
   `www/src/map/s2` `S2CellId.fromPoint(...).parentL(level).toToken()`.
2. duckdb UBIGINT bit-math and numpy bit-math both reproduce `s2sphere`'s
   parent id + token, so the memory-bounded per-level rollup is exact.
"""
import numpy as np
import pytest

from njdot.s2 import id_to_token, latlng_to_id, parent_id, parent_sql, token_sql

# (name, lat, lon) — a spread of NJ points across three S2 faces' worth of
# tokens (`89b` Cape May, `89c/89d` North Jersey).
POINTS = [
    ('JC',      40.7178, -74.0431),
    ('Newark',  40.7357, -74.1724),
    ('Trenton', 40.2206, -74.7699),
    ('CapeMay', 38.9351, -74.9060),
]

# Golden tokens from the client's `nodes2ts` (byte-for-byte target the
# worker range-scans / the client covers). Keyed (name, level).
NODES2TS_TOKENS = {
    ('JC', 4): '89d', ('JC', 8): '89c25', ('JC', 12): '89c250b',
    ('JC', 14): '89c250b1', ('JC', 16): '89c250b1d',
    ('Newark', 4): '89d', ('Newark', 8): '89c25', ('Newark', 12): '89c2537',
    ('Newark', 14): '89c25379', ('Newark', 16): '89c253789',
    ('Trenton', 4): '89d', ('Trenton', 8): '89c15', ('Trenton', 12): '89c159d',
    ('Trenton', 14): '89c159d1', ('Trenton', 16): '89c159d1d',
    ('CapeMay', 4): '89b', ('CapeMay', 8): '89bf5', ('CapeMay', 12): '89bf545',
    ('CapeMay', 14): '89bf5443', ('CapeMay', 16): '89bf54425',
}

GOLDEN_LEVELS = (4, 8, 12, 14, 16)


def _l16_ids() -> dict[str, np.uint64]:
    lat = np.array([p[1] for p in POINTS])
    lon = np.array([p[2] for p in POINTS])
    ids = latlng_to_id(lat, lon, 16)
    return {POINTS[i][0]: ids[i] for i in range(len(POINTS))}


def test_s2sphere_tokens_match_client_nodes2ts():
    """Invariant 1: Python `s2sphere` == client `nodes2ts`, exactly."""
    ids = _l16_ids()
    got = {
        (name, level): id_to_token(parent_id(np.array([ids[name]]), level)[0])
        for name in ids
        for level in GOLDEN_LEVELS
    }
    assert got == NODES2TS_TOKENS


def test_duckdb_bitmath_matches_s2sphere():
    """Invariant 2: duckdb `parent_sql`/`token_sql` == `s2sphere` for every
    level 4..16 (not just the golden subset)."""
    import duckdb
    import pandas as pd

    ids = _l16_ids()
    df = pd.DataFrame({'name': list(ids), 'l16_id': [int(v) for v in ids.values()]})
    con = duckdb.connect()
    con.register('pts', df)

    levels = list(range(4, 17))
    selects = ',\n'.join(
        f"{token_sql(parent_sql('CAST(l16_id AS UBIGINT)', lv))} AS l{lv}"
        for lv in levels
    )
    ddb = con.execute(f'SELECT name, {selects} FROM pts').df().set_index('name')

    expected = {
        (name, lv): id_to_token(parent_id(np.array([ids[name]]), lv)[0])
        for name in ids
        for lv in levels
    }
    got = {(name, lv): ddb.loc[name, f'l{lv}'] for name in ids for lv in levels}
    assert got == expected


def test_lexicographic_token_order_matches_id_order():
    """Lexicographic order of (trailing-zero-trimmed) hex tokens equals
    numeric uint64 id order — the invariant that lets the worker's
    `cellid BETWEEN lo AND hi` TEXT range scan (BINARY collation) align
    with S2's Hilbert-curve id order. Checked over a diverse cell set:
    every point's parents at levels 4..16."""
    ids = _l16_ids()
    cells = [
        (int(parent_id(np.array([l16]), lv)[0]),
         id_to_token(parent_id(np.array([l16]), lv)[0]))
        for l16 in ids.values()
        for lv in range(4, 17)
    ]
    cells = sorted(set(cells))  # unique, by id
    by_id = [tok for _id, tok in cells]
    by_token = [tok for _id, tok in sorted(cells, key=lambda c: c[1])]
    assert by_token == by_id
