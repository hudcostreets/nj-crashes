# Generalized dvx-tracked D1 mirror: per-DB stages + schema-aware diff

Two follow-on investments to the shipped incremental-import path (`specs/done/d1-import-incremental.md`), to make "a dvx-tracked SQLite `.db` is the source of truth for a D1, kept in sync by exact-diff" a robust, reusable pattern rather than a per-DB special case:

- **A. Per-DB side-effect stages** — split the one monolithic `api/d1-import.dvc` apply stage into one side-effect stage per D1-backed DB, so the "which `.db` version is live in D1" contract is recorded in the DAG (not only in D1's runtime `_metadata` stamp), and no-op days skip at the dvx level.
- **B. Schema-aware diff** *(deferred after build-vs-buy validation — see that section)* — teach `api/scripts/d1-diff.py` (+ `d1-import.sh`) to migrate schema (index/column deltas via `CREATE/DROP INDEX` / `ALTER TABLE`, table-rebuild fallback for structural changes) so a `.db` whose *schema* changed can go in incrementally, instead of forcing a full `DROP+CREATE+INSERT`.

Motivated concretely by the 2026-09 child-drop re-baseline (`0c081bc2c75`): the corrected `cmymc.db` was a pure row-content change (schema unchanged) so the daily exact-diff heals it; but the child DBs' fix also carried a *schema* change (`id INTEGER PRIMARY KEY` as rowid + dropped `ix_*_id` + trimmed `CRASH_IDXS`, see `nj_crashes/utils/sql.py`), which the current exact-diff cannot apply — it would silently keep the old schema for natural-keyed tables. That gap is what B closes.

## Background: what exists today

- **Stage 1 (per-DB, already):** each `*.db.dvc` produces a dvx-tracked SQLite (`www/public/njdot/cmymc.db.dvc` cmd `njdot cmymc`, `www/public/njsp/crashes.db.dvc`, `data/cells/cells-s2.db`, …).
- **Stage 2 (one combined side-effect):** `api/d1-import.dvc` (`side_effect: true`) runs `bash scripts/d1-import.sh --inplace njsp-crashes cmymc cells-s2` and depends on all three `.db`s. It applies exact-diffs to all three D1s in one stage.
- **Runtime skip:** inside `d1-import.sh`, per DB, `import_db_diff` reads D1's `_metadata.source_md5`, compares to the local `.db` md5, and short-circuits when equal. The prior `.db` is fetched by that md5 from the DVC cache / `s3://nj-crashes/.dvc/files/md5`; `d1-diff.py` diffs each table on natural keys (`NATURAL_KEYS = cc mc y m condition id dt cellid`) and emits `DELETE … WHERE (pk) IN (…)` + batched `INSERT`.
- **Existing fallbacks** (all correct, all full-write): no `prior_md5` stamped → full `DROP+CREATE+INSERT`; prior blob unfetchable → full; a table with no natural-key column → per-table `DROP+CREATE+INSERT`; `--full` flag forces full.

So step 1 is already per-DB; the two gaps are that step 2 is *mono* and that neither step handles a schema change on a natural-keyed table.

## A. Per-DB side-effect stages

**Change:** replace the single `api/d1-import.dvc` with one `.dvc` per D1-backed DB, e.g. `api/d1/cmymc.dvc`, `api/d1/njsp-crashes.dvc`, `api/d1/cells-s2.dvc`, each:

```yaml
meta:
  computation:
    cmd: bash scripts/d1-import.sh --inplace <db-name>
    side_effect: true
    deps:
      /<path>/<db-name>.db: <md5>
    git_deps:
      scripts/d1-import.sh: <sha>
      scripts/d1-diff.py: <sha>
```

**Why it's worth it:**

1. **The mirror contract becomes git-auditable.** Today "which `.db` is live in D1" lives only in D1's runtime `_metadata.source_md5`. With a per-DB stage, the stage's recorded dep-hash *is* that fact, versioned in git. A drift between the DAG dep-hash and D1's stamp is then detectable without a wrangler round-trip.
2. **DAG-level skip.** dvx skips a DB whose `.db` hash is unchanged without invoking wrangler at all (today the mono stage re-runs whenever *any* of its three deps change, then discovers the per-DB no-op only after a wrangler `_metadata` read).
3. **Per-DB provenance + parallelism**, and per-DB `git_deps` on both `d1-import.sh` and `d1-diff.py` (the mono stage lists only `d1-import.sh`).

**Cost / caveats:** N `.dvc`s instead of one; `d1-diff.py` should be added to `git_deps` (currently missing — a change to the differ doesn't invalidate the stage). Creds/account selection is per-stage but identical, so no real duplication. The daily workflow's stage list in `.github/workflows/daily.yml` grows from one entry to N (or a small fan-out). `batch/reproc-targets` already excludes `side_effect: true`, so the split stays out of reproc scope automatically.

## B. Schema-aware diff (deferred — see "build vs. buy" validation)

> **Status after validation:** not a separate build — **extend `d1-diff.py` with schema-migration cases as we actually hit them.** `d1-diff.py` *is* our rolled-own differ; `sqldiff` was rejected (full-replaces on schema change — no cheaper than our `--full` — and churns on our pandas rowid tables). We haven't hit a case yet: the only schema change to date (the `id`-rowid + `CRASH_IDXS` trim) exists purely to **shrink billed D1 writes for the HCCS seed** (see provenance below), and it lands *for free* at the seed — a fresh full import just creates the tables with the new schema, no in-place migration. The first real need arises when an *already-live, inc-updated* D1's `.db` schema changes (e.g. a later index audit on a formalized child DB); build that case then. The design below is the menu to draw from when that happens.
>
> **Provenance:** the schema change came from the index audit (`bc7b53b8cdb`: `id INTEGER PRIMARY KEY` + `CRASH_IDXS` 6→2 + drop pandas `ix_*_id`), motivated solely by cutting the HCCS-seed write cost (~149M → ~83M billed rows). It is independent of the child-drop *correctness* fix (`410fb93f39e`), which rode in adjacent commits but changed only row content.

**The gap:** `d1-diff.py` diffs *rows* (`SELECT … EXCEPT SELECT …` on full content, `DELETE`+`INSERT` on natural keys) and assumes prior and current `.db` share a schema. When the schema changes on a natural-keyed table, the current code silently applies row DELETE/UPSERT against the *old* D1 schema — at best a no-op on the schema, at worst an `INSERT` column-count mismatch. So any schema change today must route through the full-import escape hatch (`--full`), losing the incremental write savings.

**This is unimplemented, not impossible.** D1 is SQLite; the relevant DDL support:

| Operation | D1/SQLite support |
|---|---|
| `CREATE INDEX` / `DROP INDEX` | ✅ full |
| `ALTER TABLE … ADD COLUMN` | ✅ (with limits: no non-constant default, etc.) |
| `ALTER TABLE … DROP COLUMN` | ✅ (SQLite ≥ 3.35) |
| `ALTER TABLE … RENAME TABLE/COLUMN` | ✅ |
| Change a column's type / add/remove PRIMARY KEY / most constraint changes | ❌ in-place — needs the canonical **table-rebuild**: `CREATE` new-schema table → `INSERT…SELECT` → `DROP` old → `RENAME` |

**Design:** a `schema-diff` preamble to the existing row-diff, run per table before `d1-diff.py`:

1. Compare `PRAGMA table_info` + the index set (`sqlite_master WHERE type='index'`) of prior vs current `.db`.
2. Emit, in order:
   - **Index deltas** → `DROP INDEX <gone>` + `CREATE INDEX <added>`. (Cheap; this is *most of our win* — see below.)
   - **Column adds/drops** → `ALTER TABLE … ADD/DROP COLUMN`.
   - **Structural change** (column type, PK, constraints) not expressible via `ALTER` → **table-rebuild** for that table (writes all its rows; no incremental saving for that one table, but automatic + correct), or defer to the existing full `DROP+CREATE+INSERT` fallback.
3. Then run the row-diff as today. After a rebuild the natural keys are unchanged, so the row-diff still applies on top.

Applied to a fresh D1 (schema migration + row-diff) it also keeps D1's `_metadata.source_md5` re-stamp semantics intact (`write_metadata` still runs at the end).

**Worked example — the child-drop re-baseline's schema change.** Our change decomposes cleanly along the table above:

- **Index trim** (`DROP INDEX ix_*_id`, drop the removed `CRASH_IDXS` entries): fully expressible as `DROP INDEX`, cheap — and this is the part that matters for *ongoing* incremental cost, since each index row is a billed D1 write per upsert. A schema-aware diff would apply exactly this and nothing else for a re-index.
- **`id` as `INTEGER PRIMARY KEY` (rowid):** a structural PK change, so → table-rebuild. But note this part only ever helped the *one-time full-import* cost (fewer index rows during a full replay); it buys nothing for incremental ops, so in practice we may choose **not** to propagate the rowid-PK to D1 at all and keep only the index trim. Worth deciding per-DB rather than assuming.

So even a modest schema-diff (index + column deltas, with a rebuild/full fallback for the rare PK/type change) covers our real cases and generalizes the pattern.

**Cost / caveats:** `d1-diff.py` grows a schema-comparison path + a small DDL emitter; `d1-import.sh` applies the schema file before the delete/upsert files. Edge cases to handle explicitly (raise, don't silently full-import): an `ADD COLUMN` with a non-constant default (SQLite rejects), and a rebuild on a very large table (falls back to full-write economics — log it). Keep `--full` as the ultimate escape hatch.

## Prior art: build vs. buy

The obvious "just use it" is **`sqldiff`**, SQLite's first-party diff utility: given two `.db` files it emits SQL to transform one into the other — schema changes (table rebuilds / index DDL) **and** row `INSERT`/`UPDATE`/`DELETE`. It's the natural fit and would cover both A's row-diff and B's schema-diff in one tool.

**The catch — and the reason `d1-diff.py` exists:** `sqldiff` keys its row diff on each table's **declared `PRIMARY KEY` (or rowid)**, not on arbitrary columns. Our mirrored tables are written by pandas `to_sql`, which declares no PK, so their rowid is *insertion order* — non-stable across rebuilds, which would make `sqldiff` see every row as changed. That non-stability is exactly why the predecessor hand-rolled natural-key diffing (`NATURAL_KEYS`).

So build-vs-buy reduces to a **PK-stability decision**:

- **Buy (`sqldiff`) — preferred:** give every mirrored table a stable, content-derived `PRIMARY KEY` (children: `id`, which the re-baseline *already* made the rowid; aggregates like `cmymc`: declare the group key `(cc, mc, y, m, condition)` — already unique per row — as the PK). Then `sqldiff` handles schema + rows for free and we **retire `d1-diff.py`**. Bonus: its `UPDATE`s touch only changed rows (likely cheaper D1 writes than our `DELETE`+`INSERT`). Costs: `sqldiff` isn't in the base image (ships in the `sqlite-tools` bundle, not the distro/homebrew `sqlite3` package) → a CI install step; and PK stability must be guaranteed (our outputs are already byte-deterministic per the reproc work, so the ids/keys are stable — the precondition already holds).
- **Build (keep hand-rolled):** if we won't commit to stable PKs, keep natural-key diffing and add the schema-diff ourselves (B as drafted above).

Other tools considered and rejected: `sqlite3_rsync` (2024) needs a SQLite endpoint on both ends — D1 isn't one; `atlas` / `migra` / Alembic are schema-only or Postgres-oriented (no data diff to an arbitrary target); `dolt` is a versioned-DB engine (overkill).

### Validated `sqldiff` behavior (2026-09-11, built arm64 from `sqlite-src-3530400` on `e`)

`sqldiff` isn't packaged for arm64 (no sqlite.org bundle; `linux-x64` won't run on Graviton) — it has to be built from the amalgamation + `tool/sqldiff.c` + `ext/misc/sqlite3_stdio.{c,h}`. With it built, three probes settled the question:

| Case | `sqldiff` output |
|---|---|
| Schema stable, table has a **declared PK**, rows changed/added/removed | Ideal minimal ops: `UPDATE … WHERE pk=…`, `DELETE WHERE pk=…`, `INSERT …`. `UPDATE` is cheaper than our `DELETE`+`INSERT`. |
| Schema stable, **rowid table** (no declared PK), rows **reordered** | Keys on `rowid` → **spurious `UPDATE` for every reordered row** (3 logically-unchanged rows → 3 UPDATEs). |
| **Schema mismatch** | Falls back to `DROP TABLE + CREATE + INSERT-all` — a **full replace, no incremental savings**; does *not* emit `ALTER`/`CREATE INDEX` + a row-delta. |

Two consequences that **reverse the earlier lean toward `sqldiff`**:

- **`sqldiff` does not obviate `d1-diff.py`.** Our tables are pandas `to_sql` rowid tables (cmymc included — its `sql.write` calls pass no `pk=`), so `sqldiff` would churn on rowid reordering. Matching `d1-diff.py`'s correctness would require declaring stable content-PKs on *every* mirrored table (a schema change to the aggregates) — just to reach what the natural-key differ already does *without* that requirement, plus an arm64 build dep. `d1-diff.py` is natural-key-keyed, rowid-immune, and already wired into `d1-import.sh` + the `_metadata` contract. Its one giveaway vs `sqldiff` is `DELETE`+`INSERT` instead of `UPDATE` on *changed* rows — marginal, since most daily delta is adds.
- **Neither tool gives cheap schema migration.** `sqldiff` full-replaces on schema change exactly like our `--full` fallback. So Enhancement B (incremental schema migration) is **not** off-the-shelf from anything — it would have to be hand-built. Given schema changes are *rare* (this fix is the first in the mirror's life) and a full-replace on that rare event is acceptable (it's what the 9/24 HCCS seed does anyway), **B is not worth building now** — accept the full-replace on schema change.

**Revised recommendation:** **keep `d1-diff.py`** (don't adopt `sqldiff` — it needs stable-PK declaration + an arm64 build to merely match it). **Drop/defer Enhancement B** — no off-the-shelf cheap schema migration exists, schema changes are rare, and full-replace on them is fine. **Do Enhancement A** (per-DB stages) — engine-independent, and the actual leverage.

## Rollout order

Engine decision (build-vs-buy) is settled: **keep `d1-diff.py`**, **defer B**. Remaining work is A:

1. **A — per-DB side-effect stages** (the leverage): split `api/d1-import.dvc` into one `.dvc` per D1-backed DB; add `d1-diff.py` to each stage's `git_deps` (it's missing from the mono stage today — a real bug); update `.github/workflows/daily.yml`. Validate against a local `wrangler dev` D1 before it touches prod.
2. **B — extend `d1-diff.py` per case, when hit.** Not a standalone build; the first case arrives when an already-inc-updated D1's `.db` schema changes (index/column DDL detection + table-rebuild fallback, drawn from the menu above). Nothing to build until then.

## Open questions

- **Propagate `id`-rowid PK to D1 at all?** It helps only full-import cost. If we commit to incremental-forever per DB, we may keep D1 on the natural-key layout + trimmed indexes and skip the rowid-PK in D1 (decide per DB).
- **Reconcile the two "live md5" records** (D1 `_metadata.source_md5` vs the per-DB stage dep-hash from A): treat D1's stamp as runtime truth and the dep-hash as the intended target; a mismatch means a prior apply failed/partial — surface it rather than silently diffing against a wrong base.
- **Where the apply runs post-migration:** today RAC creds via the daily GHA; after the HCCS cutover, HCCS creds. Per-DB stages make a per-DB account cutover cleaner (matches the per-worker cutover posture).

## Status

Draft — captures the design; not yet implemented. Cross-refs: `specs/done/d1-import-incremental.md` (predecessor, shipped), `api/scripts/d1-import.sh`, `api/scripts/d1-diff.py`, `nj_crashes/utils/sql.py` (the `make_pk`/index schema this would migrate), `specs/s3-to-r2-hccs.md` (the HCCS migration that seeds the child DBs fresh).
