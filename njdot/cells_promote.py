"""Promote a rebuilt `cells-s2.db` + `s2_pyramid`: versioned D1 import → parity
report → activation (specs/cells-d1-years.md § "Import + rollout",
specs/cells-immutable-keys.md § D1).

1. **Import** the `.db`'s `cells_s2_l{N}` tables into D1 `cells-s2` as a fresh,
   versioned set `cells_s2_<md5[:8]>_l{N}` (`d1-import.sh --tables-prefix`),
   alongside the live set — skipped when that set already exists with the
   local row counts.
2. **Parity report**: per level, row count + the sum of every count column +
   the summed lengths of the text columns, new set vs. the active one (the
   R2 manifest's `d1.table_prefix`). A rebuild can legitimately change them,
   so differences are reported; `require_parity` turns any into a failure.
3. **Activate**: push the pyramid build with the new `d1.table_prefix`
   (`cells_publish.push`; shards already in R2 are skipped) and cut over
   `manifest.json` — skipped when it already names this build.

D1 and R2 sit behind seams (`D1`, `cells_publish.Storage`) so the decisions are
testable without either; `WranglerD1` is the real D1 (wrangler under `api/`).
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from nj_crashes.utils.log import err
from njdot import cells_publish
from njdot.cells_publish import DvxBlobs, PushResult, Storage

#: Fixed table-name prefix inside `cells-s2.db` (the `.db` keeps fixed names so
#: its DVX md5 is stable; only the D1 copy is versioned).
DB_TABLE_PREFIX = cells_publish.D1_TABLE_PREFIX_DEFAULT
D1_DB_NAME = 'cells-s2'
#: Summed per level (`sum(col)`), same order as `CELLS_DB_COUNT_COLS`.
COUNT_COLS = ('n_fatal', 'n_inj_ped', 'n_inj_other', 'n_pdo', 'n_vehs', 'n_killed', 'n_killed_ped')
#: Summed by length per level (`sum(length(col))`). `by_year` is compared only
#: when both table sets have it (an active set may predate it).
LEN_COLS = ('fatal_years', 'sld_name', 'mun', 'by_year')

#: level → stat name (`n_rows`, a count column, or `len_<text column>`) → value
Stats = dict[int, dict[str, int]]
ImportAction = Literal['import', 'skip', 'reimport']
Activation = Literal['activate', 'stage', 'already-active']


def table_prefix_for(db_md5: str) -> str:
    """The versioned D1 table prefix for a `.db` with this md5."""
    if not re.fullmatch(r'[0-9a-f]{32}', db_md5):
        raise ValueError(f'not an md5: {db_md5!r}')
    return f'cells_s2_{db_md5[:8]}_l'


class D1(Protocol):
    """The D1 operations promotion needs. `query` is read-only."""
    def query(self, sql: str) -> list[dict]: ...
    def import_tables(self, table_prefix: str) -> None:
        """Import the local `.db`'s tables under `table_prefix` (CREATE fails if present)."""
    def drop_tables(self, tables: list[str]) -> None: ...


class SqliteDb:
    """Read-only `query` over a local SQLite file (the `.db` being promoted)."""

    def __init__(self, path: Path) -> None:
        self.con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        self.con.row_factory = sqlite3.Row

    def query(self, sql: str) -> list[dict]:
        return [dict(r) for r in self.con.execute(sql).fetchall()]


class WranglerD1:
    """`D1` via `wrangler d1 execute --remote` (run from `api/`, whose
    `node_modules` has wrangler) and `api/scripts/d1-import.sh`. Needs
    `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the env (`infra/hccs-run`
    locally; Secrets Manager + job-def env on Batch)."""

    def __init__(self, root: Path, db_name: str = D1_DB_NAME) -> None:
        self.root = root
        self.api_dir = root / 'api'
        self.db_name = db_name

    def _execute(self, sql: str) -> list[dict]:
        proc = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', self.db_name, '--remote', '--json', f'--command={sql}'],
            cwd=self.api_dir, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f'wrangler d1 execute failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}\nSQL: {sql}')
        return json.loads(proc.stdout)

    def query(self, sql: str) -> list[dict]:
        return self._execute(sql)[0]['results']

    def import_tables(self, table_prefix: str) -> None:
        subprocess.run(
            ['bash', 'api/scripts/d1-import.sh', '--inplace', '--tables-prefix', table_prefix, self.db_name],
            cwd=self.root, check=True,
        )

    def drop_tables(self, tables: list[str]) -> None:
        if tables:
            self._execute(' '.join(f'DROP TABLE IF EXISTS "{t}";' for t in tables))


def _ident(name: str) -> str:
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
        raise ValueError(f'not an SQL identifier: {name!r}')
    return name


def list_tables(db: D1 | SqliteDb) -> dict[str, list[str]]:
    """Table name → its column names, from `sqlite_master`. Columns are parsed
    by replaying each `CREATE TABLE` into an in-memory SQLite (D1 doesn't
    reliably expose `pragma_table_info`), for the cells tables only: other
    tables in the DB (`_metadata`, D1's internal `_cf_*`) are listed with no
    columns, since nothing here reads them."""
    out = {}
    mem = sqlite3.connect(':memory:')
    for row in db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"):
        name, sql = row['name'], row['sql']
        if not name.startswith('cells_s2_') or not sql:
            out[name] = []
            continue
        mem.execute(sql)
        out[name] = [r[1] for r in mem.execute(f'PRAGMA table_info("{name}")')]
    mem.close()
    return out


def level_tables(tables: dict[str, list[str]], prefix: str) -> dict[int, str]:
    """`{level: table}` for the tables named exactly `{prefix}{level}`."""
    levels = {int(name[len(prefix):]): name for name in tables if name.startswith(prefix) and name[len(prefix):].isdigit()}
    return dict(sorted(levels.items()))


def stat_cols(*column_sets: list[str]) -> tuple[list[str], list[str]]:
    """`(count columns, length columns)` present in every given column set."""
    common = set.intersection(*(set(c) for c in column_sets))
    return [c for c in COUNT_COLS if c in common], [c for c in LEN_COLS if c in common]


def stats_sql(table: str, count_cols: list[str], len_cols: list[str]) -> str:
    """One level's parity stats: row count, `sum(col)` per count column,
    `sum(length(col))` per text column (NULL-safe: empty / all-NULL → 0)."""
    sel = [
        'count(*) AS n_rows',
        *(f'coalesce(sum({_ident(c)}), 0) AS {c}' for c in count_cols),
        *(f'coalesce(sum(length({_ident(c)})), 0) AS len_{c}' for c in len_cols),
    ]
    return f'SELECT {", ".join(sel)} FROM {_ident(table)}'


def table_stats(db: D1 | SqliteDb, tables: dict[int, str], count_cols: list[str], len_cols: list[str]) -> Stats:
    """Per-level stats, one query per level (each a full scan; one statement
    per level keeps every D1 query well under its time limit)."""
    out: Stats = {}
    for level, table in tables.items():
        rows = db.query(stats_sql(table, count_cols, len_cols))
        out[level] = {k: int(v) for k, v in rows[0].items()}
    return out


def row_counts(db: D1 | SqliteDb, tables: dict[int, str]) -> dict[int, int]:
    return {level: int(db.query(f'SELECT count(*) AS n FROM {_ident(t)}')[0]['n']) for level, t in tables.items()}


@dataclass(frozen=True)
class StatDiff:
    level: int
    stat: str
    old: int | None
    new: int | None


def diff_stats(old: Stats, new: Stats) -> list[StatDiff]:
    """Every `(level, stat)` whose value differs (None: level absent on that side)."""
    out = []
    for level in sorted(old.keys() | new.keys()):
        o, n = old.get(level, {}), new.get(level, {})
        for stat in [*o, *(k for k in n if k not in o)]:
            if o.get(stat) != n.get(stat):
                out.append(StatDiff(level, stat, o.get(stat), n.get(stat)))
    return out


def _fmt_delta(old: int | None, new: int | None) -> str:
    if old is None or new is None:
        return f'{"-" if old is None else f"{old:,}"} → {"-" if new is None else f"{new:,}"}'
    return f'{old:,} → {new:,} ({new - old:+,})'


def format_report(old: Stats, new: Stats) -> list[str]:
    """One line per level: `l17: identical (1,234 rows)`, or the differing
    stats as `old → new (±delta)`; then a summary line."""
    diffs = diff_stats(old, new)
    by_level: dict[int, list[StatDiff]] = {}
    for d in diffs:
        by_level.setdefault(d.level, []).append(d)
    lines = []
    for level in sorted(old.keys() | new.keys()):
        ds = by_level.get(level)
        if not ds:
            lines.append(f'l{level}: identical ({new[level]["n_rows"]:,} rows)')
        else:
            lines.append(f'l{level}: ' + '; '.join(f'{d.stat} {_fmt_delta(d.old, d.new)}' for d in ds))
    n_levels = len(by_level)
    lines.append('parity: identical at every level' if not diffs else f'parity: {len(diffs)} stat(s) differ across {n_levels} level(s)')
    return lines


class PartialImportError(RuntimeError):
    pass


class ParityError(RuntimeError):
    pass


def plan_import(expected: dict[int, int], existing: dict[int, int | None], reimport: bool) -> ImportAction:
    """What to do with the versioned table set, given the local `.db`'s row
    counts (`expected`) and the D1 set's (`existing`; None = table absent).

    - none present → `import`;
    - all present with the local row counts → `skip` (already imported);
    - anything else (a partial / interrupted import, or a set built from
      different bytes) → `reimport` (drop the set, import again) when
      `reimport`, else `PartialImportError`."""
    present = {lv: n for lv, n in existing.items() if n is not None}
    if not present:
        return 'import'
    if existing == expected:
        return 'skip'
    if reimport:
        return 'reimport'
    bad = sorted(lv for lv in expected.keys() | existing.keys() if existing.get(lv) != expected.get(lv))
    detail = ', '.join(f'l{lv}: {existing.get(lv)} (expected {expected.get(lv)})' for lv in bad[:5])
    raise PartialImportError(f'versioned D1 tables exist but don\'t match the local .db ({detail}); re-run with reimport to drop and re-import them')


def plan_activation(active_version: str | None, new_version: str, activate: bool) -> Activation:
    if active_version == new_version:
        return 'already-active'
    return 'activate' if activate else 'stage'


@dataclass
class PromoteResult:
    table_prefix: str
    active_prefix: str
    import_action: ImportAction
    report: list[str]
    diffs: list[StatDiff]
    activation: Activation
    data_version: str
    push: PushResult | None = None
    skipped_stats: list[str] = field(default_factory=list)


def active_table_prefix(active_manifest: dict | None) -> str:
    """The D1 table prefix the live build reads (the worker's `d1Table`
    default when a manifest predates `d1`)."""
    if active_manifest is None:
        return DB_TABLE_PREFIX
    return (active_manifest.get('d1') or {}).get('table_prefix') or DB_TABLE_PREFIX


def promote(
    *,
    d1: D1,
    local: SqliteDb,
    storage: Storage,
    manifest: dict,
    out_dir: Path,
    dvx: DvxBlobs | None = None,
    activate: bool = True,
    dry_run: bool = False,
    reimport: bool = False,
    require_parity: bool = False,
) -> PromoteResult:
    """Import → parity report → activate (see module doc). `manifest` is the
    build's manifest, already carrying the versioned `d1.table_prefix`.
    `dry_run`: reads only (D1 + R2); the "new" side of the parity report is
    the local `.db` when the import hasn't happened yet."""
    new_prefix = manifest['d1']['table_prefix']
    active_manifest = cells_publish.read_manifest(storage, cells_publish.MANIFEST_KEY)
    active_version = active_manifest['data_version'] if active_manifest else None
    old_prefix = active_table_prefix(active_manifest)

    local_tables = list_tables(local)
    local_levels = level_tables(local_tables, DB_TABLE_PREFIX)
    if not local_levels:
        raise FileNotFoundError(f'no {DB_TABLE_PREFIX}{{N}} tables in the local .db')
    expected = row_counts(local, local_levels)

    d1_tables = list_tables(d1)
    new_levels_d1 = level_tables(d1_tables, new_prefix)
    existing = {lv: None for lv in local_levels}
    existing.update(row_counts(d1, new_levels_d1))
    action = plan_import(expected, existing, reimport)
    if action != 'skip' and new_prefix in (old_prefix, DB_TABLE_PREFIX):
        raise RuntimeError(f'refusing to import into {new_prefix}*: it is the active / fixed table set')
    err(f'D1: {new_prefix}{{N}} — {action}' + (' (dry run)' if dry_run and action != 'skip' else ''))
    if not dry_run:
        if action == 'reimport':
            d1.drop_tables(sorted(new_levels_d1.values()))
        if action in ('import', 'reimport'):
            d1.import_tables(new_prefix)
        d1_tables = list_tables(d1)

    old_levels = level_tables(d1_tables, old_prefix)
    if not old_levels:
        raise RuntimeError(f'active D1 table set {old_prefix}{{N}} not found')
    old_cols = d1_tables[next(iter(old_levels.values()))]
    new_cols = local_tables[next(iter(local_levels.values()))]
    count_cols, len_cols = stat_cols(old_cols, new_cols)
    skipped = [c for c in (*COUNT_COLS, *LEN_COLS) if c not in count_cols and c not in len_cols]

    local_stats = table_stats(local, local_levels, count_cols, len_cols)
    if dry_run and action != 'skip':
        new_stats = local_stats
    else:
        new_stats = table_stats(d1, {lv: f'{new_prefix}{lv}' for lv in local_levels}, count_cols, len_cols)
        mismatch = diff_stats(local_stats, new_stats)
        if mismatch:
            raise RuntimeError(f'D1 {new_prefix}{{N}} doesn\'t match the local .db: {mismatch[:5]}')
    old_stats = table_stats(d1, old_levels, count_cols, len_cols)

    diffs = diff_stats(old_stats, new_stats)
    report = format_report(old_stats, new_stats)
    err(f'Parity: {new_prefix}{{N}} (new) vs. {old_prefix}{{N}} (active, {active_version})'
        + (f'; not compared (absent from one side): {", ".join(skipped)}' if skipped else ''))
    for line in report:
        err(f'  {line}')
    result = PromoteResult(
        table_prefix=new_prefix, active_prefix=old_prefix, import_action=action,
        report=report, diffs=diffs, activation=plan_activation(active_version, manifest['data_version'], activate),
        data_version=manifest['data_version'], skipped_stats=skipped,
    )
    if diffs and require_parity:
        raise ParityError(f'{len(diffs)} stat(s) differ from the active table set; not activating')

    if result.activation == 'already-active':
        err(f'R2: manifest.json already names {result.data_version}; nothing to activate')
        return result
    result.push = cells_publish.push(storage, manifest, out_dir, activate=activate, dvx=dvx, dry_run=dry_run)
    verb = 'would' if dry_run else 'did'
    err(f'R2: {verb} {"activate" if activate else "stage"} {result.data_version} '
        f'({len(result.push.present)} shard(s) present, {len(result.push.copied)} copies, {len(result.push.uploaded)} uploads)')
    return result
