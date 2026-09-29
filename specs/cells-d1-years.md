# Year-filtered `/v1/cells` from D1

Status: **proposed** (spec first; implementation follows on this branch).

## Problem

`cells-api` serves all-years `/v1/cells` requests from D1 `cells-s2` (`cells_s2_l{4..21}`, one row per cell, one indexed `cellid BETWEEN` scan). Any *year sub-range* (`years=2011-2013`) — and every `format=cols&group=year` request (the heatmap's lean fetch, which asks for per-year rows so it can re-aggregate locally) — falls back to the R2 parquet pyramid (`s2_pyramid/s2_l{L}/{shard}.{hash}.parquet`, one row per `(cell, year)`). Cold, those take 4–9 s per request on prod: range reads of a 60 MB file, then a parquet decode, in a worker.

Goal: serve any year range (and `group=year`) from D1, with one indexed query, same rows scanned as the all-years path.

## Sizing

| | rows | notes |
|---|---|---|
| D1 `cells-s2` today | ~5.3 M (l21 1.39 M, l20 1.22 M, l19 1.0 M, l18 0.71 M, …) | 580 MB in D1, 495–519 MB `.db` |
| pyramid `(cell, year)` rows, l10–l21 | 17.7 M | ~3.3× the all-years rows |
| D1 limit | 10 GB / db | row writes billed per row |

## Options

### A. Per-`(cell, year)` table(s) in D1

`cells_s2_y_l{L}(cellid, year, counts…, PRIMARY KEY (cellid, year))`. Query `WHERE cellid BETWEEN … AND year BETWEEN …` then `GROUP BY cellid` (in SQL or in the worker).

- ❌ 17.7 M rows: ~4.3× the row writes per full import (5.3 M → 23 M), and D1 bills writes per row.
- ❌ ~1.2 GB (a TEXT `cellid` repeated per year, plus the composite PK index duplicating it).
- ❌ A year-filtered query scans up to ~3.3× the rows of the all-years one (D1 bills rows *read*, too).
- ✅ Plain SQL; `group=year` is a straight read.

### A′. Per-year table only at coarse levels (≤ l14, say)

Small (l4–l14 is ~1 M `(cell, year)` rows). But the slow requests are the street/county views at l15–l21, which are exactly the levels it would leave on R2. Doesn't solve the problem.

### B. Compact per-year column on the existing rows (**recommended**)

One extra `TEXT` column, `by_year`, on every `cells_s2_l{L}` row: that cell's per-year counts, sparse over the years it has crashes in. The worker selects `cellid, by_year` (+ labels) with the same `cellid BETWEEN` scan and sums the requested years itself.

- ✅ Same row count (no extra row writes beyond re-writing the rows once), same rows read per query as the all-years path.
- ✅ ~130 MB more (below): the `.db` goes ~0.5 → ~0.63 GB, D1 ~0.58 → ~0.72 GB.
- ✅ Serves `group=year` too (the per-year entries *are* the rows it ships).
- ❌ Summing is in the worker, not SQL. Cheap: a hand-rolled char-code parser, no allocation per entry (see "Worker").
- ❌ The all-years columns and `by_year` are redundant; a build must keep them consistent (tested: the per-year entries sum to the all-years columns exactly).

B it is.

## Encoding

`by_year TEXT NOT NULL`:

```
by_year := entry (';' entry)*          -- ascending year, one per year with ≥1 crash in the cell
entry   := YY ':' c0 (',' c)*          -- YY = year − 2000, decimal
c       := '' | [1-9][0-9]*            -- empty = 0; trailing zero counts are dropped
```

Count order (most-often-nonzero first, so trailing-zero trimming bites):

| # | field |
|---|---|
| 0 | `n_vehs` |
| 1 | `n_pdo` |
| 2 | `n_inj_other` |
| 3 | `n_inj_ped` |
| 4 | `n_fatal` |
| 5 | `n_killed` |
| 6 | `n_killed_ped` |

Examples: a cell with one 2-vehicle PDO crash in 2013 and one 1-vehicle fatal crash (1 killed, a pedestrian) in 2019 → `13:2,1;19:1,,,,1,1,1`. A year whose crashes all have a blank severity and no vehicles is `YY:` (it still counts as a year with a crash).

These are exactly the seven counts `CellOut` carries (`COUNT_FIELDS`), with the same definitions as the all-years columns (`n_fatal`/`n_pdo` = crash counts by `severity`; `n_inj_ped` = Σ`pi`; `n_inj_other` = Σmax(`ti`−`pi`, 0) per crash; `n_vehs`/`n_killed`/`n_killed_ped` = Σ`tv`/`tk`/`pk`), so a year-filtered D1 answer is cell-for-cell the pyramid's. `fatal_years` for a range falls out of entries with `n_fatal > 0`. The FE's year-filtered views use exactly these: the stacked/bins map (`n_fatal`, `n_inj_ped`, `n_inj_other`, `n_pdo`, `n_vehs`, `n_killed`, `n_killed_ped`, `fatal_years`) and the heatmap's `HEAT_FIELDS` (the four severity counts). `n_crashes` / `n_inj` / `n_injured` exist in the pyramid but no `/v1/cells` response carries them.

Why not a dense 25-slot vector: fine cells have crashes in a handful of years (~2.2 `(cell, year)` rows per cell at l21, of 25 possible), so a dense vector is mostly zeros; sparse + empty-zero + trailing-trim is ~6 chars per entry at l13–l21. Why not a BLOB: `.dump` → `wrangler d1 execute` would carry it as hex (2× on the wire), the worker would need a varint decoder, and a TEXT column is inspectable in `wrangler d1 execute` / `sqlite3`. Why not JSON: ~3× the bytes for the same content, and `JSON.parse` allocates per entry.

### Size (measured on a sample)

Entry length measured on 3 × 3000 pyramid rows per level (first / middle / last row group of `s2_l{L}/89d.parquet`), × the manifest's per-level `(cell, year)` row counts:

| level | `(cell, year)` rows | avg entry (chars) | ≈ MB |
|---|---|---|---|
| l4–l12 | 137 k | 8.5–38.6 | 1.5 |
| l13 | 266 k | 7.3 | 2.2 |
| l14 | 598 k | 6.8 | 4.6 |
| l15 | 1.11 M | 6.5 | 8.4 |
| l16 | 1.72 M | 6.3 | 12.6 |
| l17 | 2.22 M | 6.2 | 16.0 |
| l18 | 2.59 M | 6.1 | 18.4 |
| l19 | 2.89 M | 6.1 | 20.4 |
| l20 | 3.03 M | 6.1 | 21.5 |
| l21 | 3.11 M | 6.2 | 22.4 |
| **total** | **17.7 M** | | **~128** |

So the `.db` grows ~0.50 → ~0.63 GB (plus SQLite record overhead, a few bytes per row), D1 ~0.58 → ~0.72 GB. Two table sets side by side during a versioned cutover (below) is ~1.3 GB — well under 10 GB.

## Build (`njdot compute cells db`)

`_cells_db_s2` aggregates in two stages instead of one: `(parent cell, year)` first, then per cell. Stage 2 sums the per-year counts into the existing all-years columns (unchanged values; `fatal_years` unchanged byte-for-byte), and `string_agg`s the per-year entries (`ORDER BY year`) into `by_year`. `by_year` is appended as the last column so existing column positions don't move. The duckdb connection gets an explicit `memory_limit` / `threads` / `temp_directory` (it had none — see `feedback_local_heavy_rebuilds`).

The encoder is a single SQL expression built by `njdot.cells_years.entry_sql()` (unit-tested against the Python reference `encode_entry`, plus a round trip through `_cells_db_s2` on a synthetic raw shard).

## Worker

`cells-api/src/by-year.ts`: `BY_YEAR_FIELDS`, `sumByYear(enc, y0, y1, out)` (sums the entries in range into a 7-slot array, returns the fatal years in range) and `forEachYear(enc, cb)`. Both parse char codes directly — no `split`, no per-entry allocation.

Routing in `queryCells` (rows / `format=cols`):

- all years → D1 all-years columns (unchanged);
- **year sub-range** → D1: `SELECT cellid, by_year[, labels] FROM {d1Table} WHERE <ranges>`, summed per cell, then the same severity gating, clip, `maxCells` coarsening and label cap as today;
- `labels=only` → pyramid (unchanged; labels are year-invariant and D1 has them too — a follow-up could move this, out of scope here);
- any D1 error → pyramid (unchanged).

`queryCellsByYear` (`format=cols&group=year`) tries D1 first as well: each in-range entry becomes one `(cell, year)` row, with the pyramid path's severity zeroing and "≥1 crash of a requested severity" row filter, then the same coarsening. `source` reports `"d1"`.

**Detection, no deploy skew**: the worker doesn't need to know whether the D1 tables have `by_year`. If they don't, the query fails (`no such column`), the worker falls back to the pyramid exactly as today, and remembers that table as lacking the column for `MANIFEST_TTL_MS` (60 s) so it doesn't pay a failed D1 round trip per request. A `NULL` `by_year` (a table mid-migration or a bad build) is treated as an error for the whole request → pyramid. So the new worker can deploy before, during or after the D1 import, and the old worker never selects `by_year`, so it can read the new tables unchanged.

**Caching**: unchanged. The edge-cache key already includes D1's `_metadata.source_md5`, so the import invalidates every year-filtered answer that was served from the pyramid.

## Out of scope

- **topK / crash lists**: `/v1/cells` never serves them (the pyramid's `topK` column is unused by the worker); crash lists come from `crashes-api`'s D1. Nothing changes.
- `labels=only` from D1 (above).
- Removing the pyramid: still needed for the fallback, and as the source of truth the D1 answers are checked against.

## Import + rollout

`dev` and `prod` workers bind the **same** D1 database (`cells-s2`) and read the same R2 `cells/manifest.json`, so there is no separate "dev D1". What isolates the change is the worker code (dev first) and a **versioned table set** (`specs/cells-immutable-keys.md` § D1): the new tables are imported under a fresh prefix, invisible until a manifest names them, so neither worker ever sees a half-imported table.

The exact-diff `--inplace` import can't carry a schema change (`d1-diff.py`'s `EXCEPT` needs matching columns), and `--inplace --full` drops the live tables and serves partial all-years answers while it refills them (tens of minutes). So `d1-import.sh` gains `--tables-prefix P` (cells-s2 only): rewrite `CREATE TABLE cells_s2_lN` / `INSERT INTO cells_s2_lN` → `PN` in the dump stream (line-anchored, so data can't match), `CREATE` fails if the set exists (no clobbering), no drop, then stamp `_metadata`. ~5.3 M row writes, once.

Steps (none run from this branch):

1. **Rebuild `cells-s2.db` on Batch**: push the branch, bump `nj-crashes-reproc`'s `ref` in `batch/infra/Pulumi.hccs.yaml`, `AWS_PROFILE=h pulumi up --stack hccs` (in `batch/infra`), then `AWS_PROFILE=h batch/submit -b reproc-results/cells-d1-years run -r r2 --no-commit --push each data/cells/cells-s2.db.dvc` (no `-f`; first check `dvx status data/cells/cells-s2.db.dvc` shows it stale from the `njdot/cli/cells.py` change and nothing upstream). Take `cells-s2.db.dvc` from the `reproc-results/*` branch; sanity: `sqlite3 cells-s2.db 'SELECT count(*) FROM cells_s2_l21'` equals today's, and the `.db` is ~0.6–0.7 GB.
2. **Deploy the dev worker**: `cd cells-api && pnpm exec wrangler deploy --env dev`. No behavior change yet (the live tables have no `by_year` → pyramid).
3. **Import the new table set** (laptop is fine for this): `dvx pull data/cells/cells-s2.db.dvc`, then `bash api/scripts/d1-import.sh --inplace --tables-prefix cells_s2_<v>_l cells-s2`, `<v>` = the new `.db` md5's first 8 hex chars (use `infra/hccs-run` for the CF token). Old worker + old manifest keep reading `cells_s2_l*`.
4. **Activate**: `infra/r2-run njdot compute cells push -d cells_s2_<v>_l` (pyramid unchanged ⇒ 0 uploads; writes a new manifest naming the new tables; activates). Within 60 s both workers read `cells_s2_<v>_l*`: prod (old code) serves all-years from it as before; dev serves year ranges from it too.
5. **Verify dev** (`crashes-cells-dev.hccs.dev`): a year-filtered request returns `source: "d1"` and matches the same request with D1 bypassed (the pyramid) cell-for-cell — e.g. compare `curl …/v1/cells?cells=89b,89d&res=17&years=2011-2013&polygon=<hudson>&format=cols` against a pre-deploy capture from prod; check `Server-Timing` `src=d1` and latency (target: < 1 s cold). CIC `dev.crashes.hccs.dev` map with a year sub-range, in both bins and heatmap modes.
6. **Prod worker**: `cd cells-api && pnpm exec wrangler deploy` (or `cells-api/deploy.dvc`); CIC prod (`crashes.hudcostreets.org`) with a year sub-range.
7. **Cleanup (≥48 h later)**: drop the old set: `DROP TABLE cells_s2_l4; … DROP TABLE cells_s2_l21;` via `wrangler d1 execute cells-s2 --remote` (until `cells gc --d1` exists).

Rollback: `njdot compute cells activate <prev data_version>` (manifest → old tables; the new worker then just falls back to the pyramid for year ranges), and/or redeploy the previous worker.

Note: once the live prefix is `cells_s2_<v>_l`, the old `d1-import.sh --inplace cells-s2` exact diff (which targets `cells_s2_l*`) no longer touches the live tables; subsequent cells rebuilds go through steps 1, 3, 4 with a new `<v>`.
