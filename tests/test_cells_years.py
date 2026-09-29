"""`by_year` (per-year counts packed into the `cells_s2_l{level}` rollup; see
`njdot/cells_years.py`, specs/cells-d1-years.md).

Pins the encoding (the worker's `cells-api/src/by-year.ts` decodes the same
strings — its tests reuse the literals below), that the duckdb encoder matches
the Python reference, and a `_cells_db_s2` round trip on a synthetic raw shard:
exact rows, with the all-years columns equal to the sums of `by_year`.
"""
import random
import sqlite3

import duckdb
import numpy as np
import pandas as pd
import pytest

from njdot import cells_years
from njdot.cells_years import FIELDS, decode, encode, encode_entry, entry_sql
from njdot.cli.cells import _cells_db_s2
from njdot.s2 import latlng_to_id


def counts(**kw: int) -> dict[str, int]:
    return {f: kw.get(f, 0) for f in FIELDS}


# Shared with `cells-api/src/by-year.test.ts`.
ENCODED = '13:3,1,2,1;19:1,,,,1,1,1'
DECODED = {
    2013: counts(n_vehs=3, n_pdo=1, n_inj_other=2, n_inj_ped=1),
    2019: counts(n_vehs=1, n_fatal=1, n_killed=1, n_killed_ped=1),
}


def test_encode_decode():
    assert encode(sorted(DECODED.items(), reverse=True)) == ENCODED
    assert decode(ENCODED) == DECODED


def test_encode_entry_edges():
    assert [
        encode_entry(2001, counts()),
        encode_entry(2025, counts(n_killed_ped=2)),
        encode_entry(2010, counts(n_vehs=12, n_pdo=10)),
    ] == [
        '1:',
        '25:,,,,,,2',
        '10:12,10',
    ]
    assert decode('1:;25:,,,,,,2') == {2001: counts(), 2025: counts(n_killed_ped=2)}


def test_decode_rejects_malformed():
    with pytest.raises(ValueError, match='has 8 counts'):
        decode('13:1,1,1,1,1,1,1,1')
    with pytest.raises(ValueError, match='repeats year 2013'):
        decode('13:1;13:2')


def test_entry_sql_matches_reference():
    rng = random.Random(0)
    rows = [
        (2001 + rng.randrange(25), *(rng.choice([0, 0, 0, 1, 2, 17]) for _ in FIELDS))
        for _ in range(500)
    ]
    df = pd.DataFrame(rows, columns=['year', *FIELDS])
    con = duckdb.connect()
    got = con.execute(f'SELECT {entry_sql()} FROM df').fetchall()
    assert [g for (g,) in got] == [
        encode_entry(r[0], dict(zip(FIELDS, r[1:]))) for r in rows
    ]


# Two North Jersey points: same l4 cell (`89d`), different l12 cells (tokens
# pinned by `tests/test_s2.py`'s `nodes2ts` goldens).
JC = (40.7178, -74.0431)
NEWARK = (40.7357, -74.1724)


def raw_crashes() -> pd.DataFrame:
    rows = [
        # (point, year, severity, pi, ti, tv, tk, pk)
        (JC, 2013, 'p', 0, 0, 2, 0, 0),
        (JC, 2013, 'i', 1, 3, 1, 0, 0),
        (JC, 2019, 'f', 0, 0, 1, 1, 1),
        (NEWARK, 2005, None, 0, 0, 1, 0, 0),   # blank severity: counts toward `n_vehs` only
        (NEWARK, 2013, 'i', 0, 1, 2, 0, 0),
    ]
    lat = np.array([r[0][0] for r in rows])
    lon = np.array([r[0][1] for r in rows])
    return pd.DataFrame({
        's2_l21': latlng_to_id(lat, lon, 21),
        'year': pd.array([r[1] for r in rows], dtype='int16'),
        'severity': pd.array([r[2] for r in rows], dtype='string'),
        'pi': pd.array([r[3] for r in rows], dtype='int16'),
        'ti': pd.array([r[4] for r in rows], dtype='int16'),
        'tv': pd.array([r[5] for r in rows], dtype='int16'),
        'tk': pd.array([r[6] for r in rows], dtype='int16'),
        'pk': pd.array([r[7] for r in rows], dtype='int16'),
    }).sort_values('s2_l21')


COLS = ('cellid', 'n_fatal', 'n_inj_ped', 'n_inj_other', 'n_pdo', 'n_vehs', 'n_killed', 'n_killed_ped', 'fatal_years', 'sld_name', 'by_year')


def test_cells_db_by_year(tmp_path):
    raw_dir = tmp_path / 'raw' / 's2_l21'
    raw_dir.mkdir(parents=True)
    raw_crashes().to_parquet(raw_dir / '89d.parquet', index=False)

    _cells_db_s2(21, False, '4,12', tmp_path, None)

    con = sqlite3.connect(tmp_path / 'cells-s2.db')
    tables = {
        lv: con.execute(f'SELECT {", ".join(COLS)} FROM cells_s2_l{lv} ORDER BY cellid').fetchall()
        for lv in (4, 12)
    }
    by_year_ddl = con.execute("SELECT type, \"notnull\" FROM pragma_table_info('cells_s2_l12') WHERE name = 'by_year'").fetchall()
    con.close()
    assert by_year_ddl == [('TEXT', 1)]
    assert tables == {
        4: [
            ('89d', 1, 1, 3, 1, 7, 1, 1, '2019', None, '5:1;13:5,1,3,1;19:1,,,,1,1,1'),
        ],
        12: [
            ('89c250b', 1, 1, 2, 1, 4, 1, 1, '2019', None, '13:3,1,2,1;19:1,,,,1,1,1'),
            ('89c2537', 0, 0, 1, 0, 3, 0, 0, None, None, '5:1;13:2,,1'),
        ],
    }
    # The all-years columns are exactly the sums of `by_year`.
    for rows in tables.values():
        for row in rows:
            by_year = decode(row[-1])
            assert tuple(sum(y[f] for y in by_year.values()) for f in COLS[1:8]) == row[1:8]
            fatal = [str(y) for y, c in sorted(by_year.items()) if c['n_fatal'] > 0]
            assert (','.join(fatal) or None) == row[8]


def test_fields_cover_db_count_cols():
    from njdot.cli.cells import CELLS_DB_COUNT_COLS
    assert sorted(cells_years.FIELDS) == sorted(CELLS_DB_COUNT_COLS)
