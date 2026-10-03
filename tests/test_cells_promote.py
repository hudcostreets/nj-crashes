"""`njdot.cells_promote`: versioned D1 import → parity report → activation,
with D1 faked by an in-memory SQLite and R2 by `MemStorage`."""
import json
import sqlite3
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts.storage import MemStorage

from njdot import cells_promote as cpr
from njdot import cells_publish as cp

MD5 = '0123abcd' + '0' * 24
NEW = 'cells_s2_0123abcd_l'
COUNTS = ', '.join(f'{c} INTEGER NOT NULL' for c in cpr.COUNT_COLS)
DDL = 'CREATE TABLE {t} (cellid TEXT PRIMARY KEY, ' + COUNTS + ', fatal_years TEXT, sld_name TEXT, cross_sld_name TEXT, mun TEXT, county TEXT{by_year})'


def create(con: sqlite3.Connection, table: str, rows: list[tuple], by_year: bool = True) -> None:
    con.execute(DDL.format(t=table, by_year=', by_year TEXT NOT NULL' if by_year else ''))
    width = 1 + len(cpr.COUNT_COLS) + 5 + (1 if by_year else 0)
    for r in rows:
        con.execute(f'INSERT INTO {table} VALUES ({", ".join("?" * width)})', r + (('',) if by_year else ()))


def row(cellid: str, n_fatal: int = 0, n_pdo: int = 0, fatal_years: str | None = None, sld: str | None = None, mun: str | None = None) -> tuple:
    #        n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped
    counts = (n_fatal, 0, 0, n_pdo, n_fatal + n_pdo, n_fatal, 0)
    return (cellid, *counts, fatal_years, sld, None, mun, None)


L4 = [row('89c', n_fatal=1, fatal_years='2013', sld='Rt 1', mun='Newark'), row('89d', n_pdo=3)]
L5 = [row('89c4', n_fatal=1, fatal_years='2013', sld='Rt 1', mun='Newark')]


def local_db(path: Path, l4=L4, l5=L5) -> cpr.SqliteDb:
    con = sqlite3.connect(path)
    create(con, 'cells_s2_l4', l4)
    create(con, 'cells_s2_l5', l5)
    con.commit()
    con.close()
    return cpr.SqliteDb(path)


class FakeD1:
    """In-memory SQLite standing in for D1 `cells-s2`; `import_tables` copies
    the local `.db`'s tables under the new prefix, like `d1-import.sh
    --tables-prefix`. Records every write."""

    def __init__(self, local_path: Path) -> None:
        self.con = sqlite3.connect(':memory:')
        self.con.row_factory = sqlite3.Row
        self.local_path = local_path
        self.writes: list[tuple] = []

    def query(self, sql: str) -> list[dict]:
        return [dict(r) for r in self.con.execute(sql).fetchall()]

    def import_tables(self, table_prefix: str) -> None:
        self.writes.append(('import', table_prefix))
        src = sqlite3.connect(self.local_path)
        for name, sql in src.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'"):
            new = name.replace(cpr.DB_TABLE_PREFIX, table_prefix)
            self.con.execute(sql.replace(name, new, 1))
            rows = src.execute(f'SELECT * FROM {name}').fetchall()
            if rows:
                self.con.executemany(f'INSERT INTO {new} VALUES ({", ".join("?" * len(rows[0]))})', rows)
        src.close()

    def drop_tables(self, tables: list[str]) -> None:
        self.writes.append(('drop', tuple(tables)))
        for t in tables:
            self.con.execute(f'DROP TABLE IF EXISTS {t}')


def write_build(root: Path, n: int) -> Path:
    raw = root / 'raw' / 's2_l21'
    raw.mkdir(parents=True)
    pq.write_table(pa.table({'year': pa.array([2001, 2025], pa.int16())}), raw / '89d.parquet')
    d = root / 's2_pyramid' / 's2_l4'
    d.mkdir(parents=True)
    pq.write_table(pa.table({'cellid': ['89d'], 'n_crashes': pa.array([n], pa.int32())}), d / '89d.parquet')
    return root


@pytest.fixture
def env(tmp_path):
    """(local .db, fake D1 holding the active `cells_s2_l*` set, R2 with an
    active build naming it, the new build's manifest + out_dir)."""
    local = local_db(tmp_path / 'cells-s2.db')
    d1 = FakeD1(tmp_path / 'cells-s2.db')
    create(d1.con, 'cells_s2_l4', L4, by_year=False)
    create(d1.con, 'cells_s2_l5', L5, by_year=False)
    store = MemStorage()
    old_root = write_build(tmp_path / 'old', 2)
    old = cp.build_manifest(old_root, 21, [4], 4)
    cp.push(store, old, old_root)
    root = write_build(tmp_path / 'new', 3)
    manifest = cp.build_manifest(root, 21, [4], 4, d1_table_prefix=cpr.table_prefix_for(MD5))
    return local, d1, store, manifest, root, old


def active(store: MemStorage) -> str:
    return json.loads(store.get('manifest.json'))['data_version']


def test_table_prefix_for():
    assert cpr.table_prefix_for(MD5) == NEW
    with pytest.raises(ValueError, match=r"^not an md5: 'abc'$"):
        cpr.table_prefix_for('abc')


def test_stats_sql():
    assert cpr.stats_sql('cells_s2_l4', ['n_fatal', 'n_pdo'], ['mun']) == (
        'SELECT count(*) AS n_rows, coalesce(sum(n_fatal), 0) AS n_fatal, coalesce(sum(n_pdo), 0) AS n_pdo, '
        'coalesce(sum(length(mun)), 0) AS len_mun FROM cells_s2_l4'
    )
    with pytest.raises(ValueError, match=r"^not an SQL identifier: 'x; DROP TABLE y'$"):
        cpr.stats_sql('x; DROP TABLE y', [], [])


def test_list_and_level_tables(tmp_path):
    local = local_db(tmp_path / 'a.db')
    tables = cpr.list_tables(local)
    cols = ['cellid', *cpr.COUNT_COLS, 'fatal_years', 'sld_name', 'cross_sld_name', 'mun', 'county', 'by_year']
    assert tables == {'cells_s2_l4': cols, 'cells_s2_l5': cols}
    assert cpr.level_tables({**tables, 'cells_s2_0123abcd_l4': [], '_metadata': []}, 'cells_s2_l') == {4: 'cells_s2_l4', 5: 'cells_s2_l5'}
    assert cpr.level_tables({**tables, 'cells_s2_0123abcd_l4': []}, NEW) == {4: 'cells_s2_0123abcd_l4'}


def test_table_stats(tmp_path):
    local = local_db(tmp_path / 'a.db')
    count_cols, len_cols = cpr.stat_cols(cpr.list_tables(local)['cells_s2_l4'])
    assert (count_cols, len_cols) == (list(cpr.COUNT_COLS), ['fatal_years', 'sld_name', 'mun', 'by_year'])
    assert cpr.table_stats(local, {4: 'cells_s2_l4', 5: 'cells_s2_l5'}, count_cols, len_cols) == {
        4: {'n_rows': 2, 'n_fatal': 1, 'n_inj_ped': 0, 'n_inj_other': 0, 'n_pdo': 3, 'n_vehs': 4, 'n_killed': 1, 'n_killed_ped': 0,
            'len_fatal_years': 4, 'len_sld_name': 4, 'len_mun': 6, 'len_by_year': 0},
        5: {'n_rows': 1, 'n_fatal': 1, 'n_inj_ped': 0, 'n_inj_other': 0, 'n_pdo': 0, 'n_vehs': 1, 'n_killed': 1, 'n_killed_ped': 0,
            'len_fatal_years': 4, 'len_sld_name': 4, 'len_mun': 6, 'len_by_year': 0},
    }


def test_stat_cols_skips_by_year_absent_on_one_side():
    old = ['cellid', *cpr.COUNT_COLS, 'fatal_years', 'sld_name', 'mun']
    new = [*old, 'by_year']
    assert cpr.stat_cols(old, new) == (list(cpr.COUNT_COLS), ['fatal_years', 'sld_name', 'mun'])


def test_diff_and_report():
    old = {4: {'n_rows': 2, 'n_fatal': 1}, 5: {'n_rows': 10, 'n_fatal': 3}, 6: {'n_rows': 1, 'n_fatal': 0}}
    new = {4: {'n_rows': 2, 'n_fatal': 1}, 5: {'n_rows': 1_012, 'n_fatal': 2}, 7: {'n_rows': 4, 'n_fatal': 0}}
    assert cpr.diff_stats(old, new) == [
        cpr.StatDiff(5, 'n_rows', 10, 1_012),
        cpr.StatDiff(5, 'n_fatal', 3, 2),
        cpr.StatDiff(6, 'n_rows', 1, None),
        cpr.StatDiff(6, 'n_fatal', 0, None),
        cpr.StatDiff(7, 'n_rows', None, 4),
        cpr.StatDiff(7, 'n_fatal', None, 0),
    ]
    assert cpr.format_report(old, new) == [
        'l4: identical (2 rows)',
        'l5: n_rows 10 → 1,012 (+1,002); n_fatal 3 → 2 (-1)',
        'l6: n_rows 1 → -; n_fatal 0 → -',
        'l7: n_rows - → 4; n_fatal - → 0',
        'parity: 6 stat(s) differ across 3 level(s)',
    ]
    assert cpr.format_report(old, old) == [
        'l4: identical (2 rows)',
        'l5: identical (10 rows)',
        'l6: identical (1 rows)',
        'parity: identical at every level',
    ]


@pytest.mark.parametrize('existing, reimport, expected', [
    ({4: None, 5: None}, False, 'import'),
    ({4: 2, 5: 1}, False, 'skip'),
    ({4: 2, 5: None}, True, 'reimport'),
    ({4: 2, 5: 7}, True, 'reimport'),
])
def test_plan_import(existing, reimport, expected):
    assert cpr.plan_import({4: 2, 5: 1}, existing, reimport) == expected


def test_plan_import_partial_raises():
    with pytest.raises(cpr.PartialImportError, match=r"^versioned D1 tables exist but don't match the local \.db \(l5: None \(expected 1\)\); "):
        cpr.plan_import({4: 2, 5: 1}, {4: 2, 5: None}, False)


@pytest.mark.parametrize('active_version, activate, expected', [
    ('s2-new', True, 'already-active'),
    ('s2-new', False, 'already-active'),
    ('s2-old', True, 'activate'),
    ('s2-old', False, 'stage'),
    (None, True, 'activate'),
])
def test_plan_activation(active_version, activate, expected):
    assert cpr.plan_activation(active_version, 's2-new', activate) == expected


def test_active_table_prefix():
    assert cpr.active_table_prefix(None) == 'cells_s2_l'
    assert cpr.active_table_prefix({'data_version': 's2-x'}) == 'cells_s2_l'
    assert cpr.active_table_prefix({'d1': {'table_prefix': NEW}}) == NEW


IDENTICAL = ['l4: identical (2 rows)', 'l5: identical (1 rows)', 'parity: identical at every level']


def test_promote_then_idempotent(env):
    local, d1, store, manifest, root, old = env
    res = cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root)
    assert (res.table_prefix, res.active_prefix, res.import_action, res.activation) == (NEW, 'cells_s2_l', 'import', 'activate')
    # The active set predates `by_year`, so it isn't compared.
    assert (res.report, res.diffs, res.skipped_stats) == (IDENTICAL, [], ['by_year'])
    assert d1.writes == [('import', NEW)]
    assert active(store) == manifest['data_version']
    assert cpr.level_tables(cpr.list_tables(d1), NEW) == {4: f'{NEW}4', 5: f'{NEW}5'}

    # Re-run: nothing to import, nothing to activate, no writes anywhere.
    before = sorted(k for k, _ in store.list_with_mtime(''))
    again = cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root)
    assert (again.active_prefix, again.import_action, again.activation, again.push) == (NEW, 'skip', 'already-active', None)
    assert again.report == IDENTICAL
    assert again.skipped_stats == []
    assert d1.writes == [('import', NEW)]
    assert sorted(k for k, _ in store.list_with_mtime('')) == before


def test_promote_dry_run_writes_nothing(env):
    local, d1, store, manifest, root, old = env
    res = cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root, dry_run=True)
    assert (res.import_action, res.activation, res.report) == ('import', 'activate', IDENTICAL)
    assert (res.push.uploaded, res.push.manifest_written, res.push.activated) == ([manifest['shards']['s2_l4/89d']['key']], True, True)
    assert d1.writes == []
    assert cpr.level_tables(cpr.list_tables(d1), NEW) == {}
    assert active(store) == old['data_version']


def test_promote_reports_diffs_and_require_parity(env, tmp_path):
    _, d1, store, manifest, root, old = env
    changed = local_db(tmp_path / 'changed.db', l5=[*L5, row('89c8', n_pdo=2, mun='Nutley')])
    d1.local_path = tmp_path / 'changed.db'
    with pytest.raises(cpr.ParityError, match=r'^4 stat\(s\) differ from the active table set; not activating$'):
        cpr.promote(d1=d1, local=changed, storage=store, manifest=manifest, out_dir=root, require_parity=True)
    # Imported (the versioned set is invisible until activated), not activated.
    assert d1.writes == [('import', NEW)]
    assert active(store) == old['data_version']

    res = cpr.promote(d1=d1, local=changed, storage=store, manifest=manifest, out_dir=root)
    assert (res.import_action, res.activation) == ('skip', 'activate')
    assert res.report == [
        'l4: identical (2 rows)',
        'l5: n_rows 1 → 2 (+1); n_pdo 0 → 2 (+2); n_vehs 1 → 3 (+2); len_mun 6 → 12 (+6)',
        'parity: 4 stat(s) differ across 1 level(s)',
    ]
    assert active(store) == manifest['data_version']


def test_promote_no_activate_stages(env):
    local, d1, store, manifest, root, old = env
    res = cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root, activate=False)
    assert (res.activation, res.push.activated, res.push.manifest_written) == ('stage', False, True)
    assert active(store) == old['data_version']
    assert store.get(cp.manifest_key(manifest['data_version'])) == cp.dumps(manifest)


def test_promote_partial_import(env):
    local, d1, store, manifest, root, old = env
    create(d1.con, f'{NEW}4', L4)   # interrupted import: l4 only
    with pytest.raises(cpr.PartialImportError):
        cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root)
    assert d1.writes == []
    res = cpr.promote(d1=d1, local=local, storage=store, manifest=manifest, out_dir=root, reimport=True)
    assert (res.import_action, res.report) == ('reimport', IDENTICAL)
    assert d1.writes == [('drop', (f'{NEW}4',)), ('import', NEW)]
    assert active(store) == manifest['data_version']
