# Incremental D1 import (exact diff against prior state)

## Problem

`api/scripts/d1-import.sh --inplace njsp-crashes cmymc` runs daily via
`.github/workflows/daily.yml` (the `api/d1-import.dvc` stage). Until now
it has done a full `DROP TABLE` + `CREATE` + `INSERT` replay of every
row in every table, every day.

Per-day write volume:

| db | rows/run |
|---|---|
| `njsp-crashes` (1 table: `crashes`) | ~15,000 |
| `cmymc` (12 tables) | ~679,000 |
| **total** | **~694k** |

Per-day cost: ~20.8M D1 Rows Written/mo, which is ~37% of the 50M
free-tier ceiling alone. At $1/M after the free tier, this stage
contributes ~$15-20/mo to the CF bill at current cadence.

Only a small fraction of the rows actually change between runs. NJSP
appends new fatal crashes and occasionally updates a victim
classification; NJDOT-derived aggregates change only for the years
the upstream `aashto_supplemented_crashes` job touches.

## Rejected: time-windowed partition delta

An earlier draft of this spec proposed `DELETE WHERE y >= MAX(y) - 1`
for cmymc and `DELETE WHERE dt >= '<90d ago>'` for crashes. EDA on
`njsp/data/crash-log.parquet` killed it for `crashes`:

- **5.2%** of new NJSP fatal crashes (132 over 4 years) take more than
  90 days to first appear in the XML feed. Lag-365d events exist.
- **74%** of update events on existing crashes have a rundate-vs-dt
  lag > 90 days. Most updates land on crashes 3+ months old — late
  victim classification edits.

For `cmymc`, the window heuristic is closer to correct (NJDOT raw data
is frozen at year-end), but `aashto_supplemented_crashes` can edit
years > `MAX(y) - 1` when NJSP late-discovers a fatality from an older
year. Less acute than `crashes` but still a correctness gap.

The fundamental flaw: a window is a heuristic, not data. We have the
actual deltas; we should use them.

## Solution: ATTACH-based exact diff against prior state

Every `.db` file is DVC-tracked, so DVC's S3 remote already mirrors
every committed version keyed by md5. D1's existing `_metadata` row
stamps the `source_md5` that was imported. Together, this gives us
the exact prior state to diff against.

Per-db flow:

```
1. Read D1's `_metadata.source_md5` for this db    (1 wrangler call)
   prior_md5 := result
   current_md5 := md5sum(local <db>.db)

2. If prior_md5 == current_md5: no-op, exit         (quiet-day path)

3. If prior_md5 is NULL or not retrievable: full import
                                                    (bootstrap / recovery)
4. Fetch prior .db from DVC remote at prior_md5     (S3 download)
   prior.db := <local cache>/<prior_md5>.db

5. For each table T:
   ATTACH 'prior.db' AS prior;
   pk := dim_columns(T)        # see "Natural keys" below

   # Rows present in current but not in prior, by full content
   delta_new := SELECT * FROM main.T EXCEPT SELECT * FROM prior.T;

   # PKs to clear: rows cleanly removed upstream, plus rows whose
   # content changed (so the DELETE+INSERT cycle replaces them).
   delete_pks := (SELECT pk FROM prior.T EXCEPT SELECT pk FROM main.T)
              UNION (SELECT pk FROM delta_new);

   # Emit SQL:
   #   DELETE FROM T WHERE (pk_cols) IN (delete_pks);
   #   INSERT INTO T VALUES ... (delta_new rows);
   # Apply via wrangler_exec.

6. UPDATE _metadata SET source_md5 = current_md5;
```

### Bootstrap & recovery paths

- **First run after this lands**: D1's `_metadata.source_md5` is the
  md5 of whatever was imported last under the old DROP+INSERT flow.
  That md5 *is* in DVC remote (every committed .db is). So the first
  ATTACH-diff has a real prior state — no special bootstrap path
  needed for normal upgrade. Worst case the diff is "everything is
  different" → re-import as usual.
- **`prior_md5` is NULL** (truly fresh D1 binding): fall back to
  `--full` (DROP+CREATE+INSERT) for that db. Spec'd at script.
- **`prior_md5` not in DVC remote** (rare; remote pruned an old md5
  for some reason): fall back to `--full`.
- **`--full` escape hatch**: forces DROP+CREATE+INSERT for every
  table, bypassing the diff. Use after schema changes (CREATE TABLE
  IF NOT EXISTS won't pick up new columns) or as a quarterly
  sanity-resync.

### Natural keys

The DELETE step needs each table's natural key columns. The cmymc-style
tables follow a compact convention: every column whose name is in the
universal set `{cc, mc, y, m, condition}` is a dim column; everything
else (`drivers`, `passengers`, `hit_run`, `towed`, …) is a metric.
This is true for all 12 cmymc tables (verified — `cmyc(cc, mc, y,
condition)`, `cmymc(cc, mc, y, m, condition)`, `yv(y)`, etc.).

`njsp-crashes.crashes` has `id` as its (unique) row identifier.

The script reads `pragma_table_info(<table>)` and picks the cols whose
names are in the universal set. Configurable per-db override available
if a future table needs it.

### Quiet-day no-op

When `prior_md5 == current_md5` the script exits with zero writes.
On days where the upstream `cmymc.dvc` produces a byte-identical
output (which does happen — e.g. if no new NJSP crashes hit
yesterday and AASHTO didn't refresh), this saves the entire diff
phase too.

## Implementation sketch

`api/scripts/d1-import.sh` gets:

1. `read_source_md5(db_name)` — queries D1's `_metadata.source_md5`,
   echoes the md5 string (or empty if NULL).
2. `fetch_prior_db(db_name, md5)` — resolves `.dvc` md5 to the DVC
   remote cache path (e.g. `s3://…/<md5[:2]>/<md5[2:]>`) and copies
   into a tmp file. Falls back to `dvx pull --rev=<commit>` if direct
   S3 path doesn't work for a given remote backend.
3. `natural_key_cols(local_db, table)` — `sqlite3` query against the
   local db's `pragma_table_info`, filters to columns whose name is
   in the universal dim set.
4. `compute_table_diff(curr_db, prior_db, table, pk_cols)` —
   ATTACHes prior to curr, emits a `<table>_delete.sql` (DELETE by
   PK tuples) and a `<table>_upsert.sql` (INSERT VALUES for the
   delta rows). Reuses `dump-compat.py` for SQLite-version-portability.
5. `import_table_diff(db_name, table, ...)` — composes (1)-(4) into
   the per-table import, calls `wrangler_exec` for delete + upsert.
6. New top-level mode dispatch in `import_data`:
   - `--full` or `MODE=remote` (staging-swap, always full) →
     existing legacy path
   - Default for `MODE=inplace` or `MODE=local` → exact-diff path

`write_metadata()` continues to stamp `source_md5` on every successful
import; the diff path reads it back on the next run.

## Tests

- `test_exact_diff.sh` — replaces `test_partition_flow.sh`. Synthetic
  prior + current sqlite (rows added, rows changed, rows deleted).
  Asserts dest (started from prior) converges to current via the
  generated DELETE + INSERT pair, including:
  - Row added upstream (in current only) → INSERT
  - Row removed upstream (in prior only) → DELETE
  - Row whose metric column changed (same PK) → DELETE+INSERT
  - Table without PK in universal set → skipped from diff, falls
    back to DROP+INSERT (verifies the natural-key detector)
- `test_real_db_dryrun.sh` — keeps the dry-run shape but compares
  against a synthetically-perturbed prior of the real `cmymc.db` /
  `crashes.db`, prints actual delta sizes (which should be small).

## Cost summary

| | rows/day | rows/mo (30d) | $/mo over free tier* |
|---|---|---|---|
| Today (full DROP+INSERT) | ~694k | ~20.8M | ~$15-19 |
| After (exact diff) | ~0–5k typical | ~150k–1.5M | ~$0 |
| Quiet day | 0 | 0 | $0 |

\* Assumes free tier is otherwise consumed by other workloads.

## Walltime

Today's d1-import stage took 66.8s on the daily GHA. New flow estimate:

- Quiet day (`prior_md5 == current_md5`): ~3-5s (md5 check + early exit)
- Normal day:
  - md5 + DVC fetch: ~10-20s for cmymc (~64MB), ~1s for crashes (~2MB)
  - Local ATTACH + diff queries: <1s
  - Wrangler apply: proportional to delta — typically thousands of
    rows for cmymc, dozens for crashes, so ~5-15s
- Worst case (full bootstrap): same as today's 66.8s

Net: typical day ~25-40s, well within the same wall budget.

## Out-of-scope (separate)

- `crash-log` viz at e.g. `/refresh-lag`: scatter of crash-dt × first
  rundate, faceted by year/county, with percentile annotations. Useful
  follow-up to surface the data this spec relied on. Not blocking.
- Applying the same flow to the bigger NJDOT dbs
  (`crashes`/`vehicles`/`occupants`/`pedestrians`). They run on
  manual cadence today, but the same `--inplace` exact-diff would
  also benefit them — apply once this design is proven on cmymc
  and njsp-crashes.
