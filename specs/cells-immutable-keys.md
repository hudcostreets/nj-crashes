# Immutable, cut-over-friendly keys for the cells pyramid

Status: **B implemented** on branch `cells-immutable-keys` (worker + `cells manifest|push|activate|gc` + tests). Not yet deployed or pushed to R2; the first promotion under it is the migration in "Runbook" below. D1 versioned tables: worker side done, import side proposed (below).

## Problem

`njdot compute cells push` was `aws s3 sync --delete data/cells/ s3://crashes/cells/`: fixed names (`s2_pyramid/s2_l{L}/{shard}.parquet`), overwritten in place, stale objects deleted. That is:

- **Torn reads.** During a sync, a request can read a mix of old and new shards (the manifest's `data_version`, which keys the ETag and edge cache, flips whenever `manifest.json` happens to land in the sync order).
- **No rollback.** The previous build is gone the moment the sync finishes.
- **Stale caches.** `parquet.ts`'s per-isolate footer cache is keyed by R2 key and documented as "the pyramid is immutable" — an in-place overwrite made that false (a warm isolate would pair an old footer with new bytes until it recycled).
- **Deploy-coupled cutover.** The 2026-09-28 promotion avoided all that by pushing to a new prefix (`cells-e710a3c/`) and flipping `CELLS_PREFIX` in `wrangler.toml` for prod and dev (`3436d9f3167`) — a worker deploy per data promotion, and a manual convention.

D1 (`cells-s2`, serving every all-years `/v1/cells` request) has its own version of this: the daily `api/d1-import.dvc` runs `d1-import.sh --inplace` (exact diff: per-table DELETE + UPSERT batches), so for the minutes it runs, D1 is partially updated, and it moves independently of the R2 pyramid.

## Options

### A. Versioned prefix per build

`cells push` derives `cells-<sha>/` from `manifest.data_version` and syncs there (no `--delete` needed: the prefix is fresh). Cutover = set `CELLS_PREFIX` + `wrangler deploy`; rollback = set it back + deploy; GC = delete old prefixes.

- ✅ No worker code changes; trivially immutable (a prefix is written once).
- ✅ Data and worker code cut over together — useful when a data change needs new worker code.
- ❌ Every promotion and rollback is a deploy (+ a `wrangler.toml` commit, which `cells-api/deploy.dvc` then sees as a change).
- ❌ No sharing across builds, whole-prefix GC only, and `raw/` + `s2-sld.parquet` (which the worker never reads) get mirrored every time.

### B. Content-hashed shard keys in one prefix, manifest as registry (**recommended; implemented**)

One cells root (`CELLS_PREFIX`, back to `cells`):

```
s2_pyramid/s2_l{level}/{shard}.{hash:12}.parquet   # immutable shard blobs (pyrmts keyTemplate grammar)
manifests/{data_version}.json                      # immutable, one per build
manifest.json                                      # the only mutable object: the active build
```

- **Keys**: pyrmts's `{hash:N}` token (`pyrmts.keys.substitute_key`), N = 12: the hash only has to be unique among versions of one `(level, shard)` slot. Human-readable (`s2_pyramid/s2_l21/89d.dd93aba96f30.parquet`), and pyrmts's "human-readable + hash suffix" shape, so a later move to the pyrmts engine (C) keeps the keys.
- **Registry**: the manifest. Schema 6 adds `shards: {"s2_l21/89d": {key, md5, bytes}, …}`, `key_template`, and `d1: {table_prefix, source_md5}`. It is deterministic: `data_version = "s2-" + md5(everything else)[:12]` (no timestamp or git SHA), so re-pushing a build is a no-op end to end and doesn't bust the edge cache.
- **Write protocol** (`pyrmts.keys.put_shard`): HEAD → if present, identical by construction (the md5 ETag is verified when R2 returns a single-part one) → skip; else put. Never overwrite, never delete inline. Then `manifests/{v}.json` (put-if-absent; an existing one with different bytes is an error). Then — last — `manifest.json`: the atomic cutover.
- **No re-upload**: every pyramid file is already in the same bucket as a DVX remote blob (`.dvc/files/md5/ab/cdef…`, pushed by the `dvx push -r r2` that commits the build), and the shard's `{hash}` *is* that md5. So `put` is an S3 `CopyObject` from the DVX blob when it exists (bytes never leave R2), falling back to uploading the local file. Checked against R2 for the current build: **36/36 shards copyable, 0 uploads**.
- **Worker**: reads `manifest.json` (per-isolate cache, re-read every 60 s), resolves each shard through `shards` (or the fixed-name layout when the manifest has none — so it still serves `cells-e710a3c/` unchanged), loads the manifest once per request and threads it through (one build per request, even across a cutover), and takes the D1 table names from `d1.table_prefix`.
- **Cutover / rollback**: `cells activate <data_version>` copies `manifests/<v>.json` over `manifest.json` after HEAD-checking all its blobs. Propagates within the 60 s TTL. No deploy.
- **GC** (`cells gc`, dry run by default): retained builds = active + newest `-k 3` pushed + any pushed within the grace (48 h); deletes hashed-shape blobs no retained manifest references and older than the grace, plus non-retained manifests; re-reads the retained set right before deleting (a build pushed/activated meanwhile keeps its blobs); never touches mtime-less or non-hashed keys, except `--legacy`, which clears the old fixed-name layout (`s2_pyramid/s2_l{L}/{shard}.parquet`, `raw/`, `s2-sld.parquet`) once the prefix's active manifest is schema 6. These are `pyrmts_engine.gc.gc_orphans`'s semantics, reimplemented (see "pyrmts" below).

### B′. Serve straight from the DVX remote's blobs

Manifest keys = `.dvc/files/md5/…` directly: zero copies. Rejected: it hands the serving lifetime to DVX GC. `specs/dvx-gc-ephemeral-artifacts.md` plans `dvx gc --older-than 30d --cloud`, and any workspace-scoped `dvx gc -c` run at a commit whose `.dvc`s have moved past the *active* build would delete live shards. Keys would also be opaque in R2 listings. The copy costs ~0.6 GB per retained build (≈ $0.01/month each at R2's $0.015/GB-month) and no bandwidth.

### C. Full pyrmts engine + registry adoption

The pyramid would be built by `pyrmts_engine` (polars) with a `pyramid_shards` registry in D1 and served via `pyrmts-cfw`. Rejected for now: pyrmts slots are `(tier, shard_dur, period)` (time); cells slots are `(level, spatial shard)` over all years, rebuilt whole, so the engine's incremental period machinery (fill, cascade, canonicalize, adopt) has nothing to act on, and it would mean rewriting a working build + serving path. B keeps pyrmts's key grammar and write protocol, so the keys and semantics carry over if the column-cube work (`pyrmts/specs/pyrmts-column-cube.md`) makes C attractive later.

## Dedupe: what content-hashing actually saves here

Measured on the committed `.dir` listings of `data/cells/s2_pyramid` (per-file md5s, DVX cache):

| Builds | Identical shards | Identical bytes |
|---|---|---|
| `2dd0212` (2026-08-31 re-baseline) → `74ad88f` (2026-09-27 recovered points, active) | **0 / 36** | **0 / 602.1 MB** |
| `308822e` (2026-08-26) → `2dd0212` | 0 / 36 | 0 / 489.6 MB |

Unsurprising in hindsight: shards are l4 parents, and NJ is two l4 cells, one of which (`89b`) holds a sliver (0.2 MB of 86 MB at l21). Every level is effectively one file, so any change anywhere rewrites all 18 of them.

Counterfactual, re-sharding the same two builds' rows finer (each level file's rows grouped by their l8 / l10 parent and hashed per group, over levels 8/12/15/18/21): **l8: 45/195 shards, 463 / 6.9 M rows identical; l10: 536/1844 shards, 1,636 / 6.9 M rows (0.02%)** — only near-empty edge shards survive. The recovered-points change touched essentially every populated area. A daily-sized delta (a few NJSP fatals) *would* dedupe well at l8–l10, but finer shards cost R2 GETs per request, and the pyramid isn't pushed daily.

So dedupe is not why B wins. B wins on: immutability (no torn reads, correct footer cache), deploy-free atomic cutover and rollback, one switch (`manifest.json`) that selects both the R2 build and its D1 tables, reference-based GC with a rollback window, and zero upload bytes via the DVX copy.

## D1

Today: one IaC-declared DB (`cells-s2` in `infra/__main__.py`), tables `cells_s2_l{4..21}` (5,217,225 rows, 519 MB), diffed in place daily.

| | In-place diff (today) | Staging-swap (`d1-import.sh`, no flags) | **Versioned tables in `cells-s2`, selected by the manifest** |
|---|---|---|---|
| Cutover | partial for minutes | atomic, via `wrangler deploy` | atomic, with `manifest.json` |
| Rollback | re-import | edit id + deploy | `cells activate <old>` |
| IaC | ✅ | ❌ new DBs outside Pulumi (`wrangler d1 create`), prod bound to an unmanaged DB | ✅ same DB |
| Works for `cells-s2` today | ✅ | ❌ it rewrites `api/wrangler.toml`, which has no `cells-s2` (the binding is in `cells-api/wrangler.toml`) | worker ✅, import ⏳ |
| Write cost | Δ rows | full (~5.2 M rows + PK index) | full per promotion |

**Recommendation: versioned tables.** Worker side is implemented: `d1Table(manifest, level)` = `{d1.table_prefix}{level}` (validated identifier; default `cells_s2_l`, so current builds are unaffected). Import side (next):

1. `d1-import.sh --inplace --tables-prefix cells_s2_<v>_l cells-s2`: create + fill tables under the new prefix (rewrite `CREATE TABLE cells_s2_l` / `INSERT INTO cells_s2_l` in the dump stream; the `.db` keeps fixed names so its DVX md5 is stable). Full import, ~10 M row writes per promotion (within D1's included 50 M/month; not something to do daily).
2. `cells manifest -d cells_s2_<v>_l` records it; `cells activate` switches R2 + D1 together.
3. `cells gc` learns `--d1`: drop `cells_s2_*_l*` table sets no retained manifest names. At 519 MB per set, keep=3 is ~1.6 GB of D1's 10 GB.
4. Decide the daily job: stop the daily `cells-s2` import (coherent builds; all-years D1 and year-filtered pyramid always agree — today they don't, since only D1 is refreshed daily), or keep diffing into the active set (fresher, partial window). Recommend stopping it once promotions are routine.

**Found while here (fixed on this branch):** the edge cache added 2026-09-28 (`008ef38b6fb`) keys on `data_version`, which only moves on an R2 push, while D1 changes daily — so all-years answers could be served from the edge up to a week after a D1 import. The worker now salts the ETag + edge-cache key with D1's `_metadata.source_md5` (stamped by every `d1-import.sh` run; read once a minute per isolate; falls back to `data_version` alone if unreadable).

## Deploy skew

- **Worker ↔ data**: the worker reads schema 5 and 6 manifests, so deploy the worker first, verify, then push/activate data; cutover no longer needs a deploy. A data change that needs new worker code (new parquet columns, new `d1` fields) still deploys the worker first, gated on `schema_version`. Never activate a build whose shape the deployed worker can't read.
- **Worker ↔ FE**: the FE fetches `/v1/manifest` once per page and caches `/v1/cells` responses by URL; browsers hold responses up to 1 h (+24 h SWR). A cutover mid-session can leave a tab mixing tiles from both builds until reload — as today. The ETag changes with the version, so revalidations pick up the new build.
- **Isolates**: any isolate's manifest is ≤60 s stale (a failed refresh keeps the previous one, logged). The 48 h GC grace covers that, in-flight requests, and a rollback window.

## DVX interplay

- Local outputs keep fixed names (`data/cells/s2_pyramid/s2_l{L}/{shard}.parquet`), so `.dvc` files and `.dir` hashes are unchanged; hashed names exist only in R2 keys and the manifest. `manifest.json` stays a gitignored local artifact.
- The shard hash is the DVX per-file md5, so `cells push` checks the local files against the committed `s2_pyramid.dvc` `.dir` (local cache, else the public remote) and refuses an uncommitted build (`-u` overrides). A promoted build is therefore always reproducible from a commit.
- `manifests/{v}.json` records the D1 source as committed (`cells-s2.db.dvc`'s md5), not the local file, so the manifest doesn't depend on whether the 0.5 GB `.db` is pulled.
- `cells push` needs the pyramid files locally (it hashes them; the copies are server-side): `dvx pull data/cells/s2_pyramid.dvc data/cells/raw/s2_l21.dvc` (~0.7 GB), or run it on Batch.

## pyrmts

Reused: `pyrmts.keys` (`substitute_key`, `{hash:N}` grammar, `put_shard`, `slot_of`, `parse_key`, `legacy_template`) and `pyrmts.storage` (`S3Storage`, `MemStorage` in tests), via a Python dep on the core package at `0e3a230` (`r/main`). Two frictions, written up as `pyrmts/specs/core-gc-and-pyarrow-range.md` (for the pyrmts session to commit and implement):

1. The core pins `pyarrow==22.0.0`; crashes pins 21 (DVX md5s). Worked around with `[tool.uv] override-dependencies = ["pyarrow==21.0.0"]` in `pyproject.toml`. Drop it once pyrmts uses a range.
2. `gc_orphans` lives in `pyrmts_engine` (polars) and wants a `Pyramid` + `ShardIndex`; crashes' registry is a set of manifests. `cells_publish.gc` mirrors its semantics (~40 lines). Swap to `pyrmts.gc.gc_orphans(storage, template, referenced=…)` once it lands in the core.

The worker needs no pyrmts change: it reads keys from the manifest, never expands a template.

## Implementation (this branch)

- `njdot/cells_publish.py`: `build_manifest`, `push` (+ `DvxCopyStorage` / `R2DvxBlobs`), `activate`, `gc`, `check_against_dvx`.
- `njdot/cli/cells.py`: `cells manifest` (schema 6), `cells push` (no more `aws s3 sync --delete`; `-A` stage only, `-n` dry run, `-C` no DVX copy, `-u` allow uncommitted), `cells activate`, `cells gc` (`-a` apply, `-g` grace hours, `-k` keep, `-l` legacy).
- `cells-api/src/manifest.ts`: schema-6 types, 60 s TTL cache, `pyramidShardKey`, `d1Table`, `loadD1Version` / `servingVersion`; `cells.ts` threads one manifest per request; `index.ts` salts ETag + edge key with the D1 stamp.
- Tests: `tests/test_cells_publish.py` (manifest determinism, push idempotency / DVX copy / staging, activate + rollback + incomplete-build refusal, gc keep/grace/rollback/legacy/re-read race), `cells-api/src/immutable-keys.test.ts` (key resolution, legacy fallback, TTL refresh + failure, D1 table + version, and a pyramid read through hashed keys matching the legacy layout cell-for-cell).
- `pyproject.toml` / `uv.lock`: `pyrmts` (core) + the pyarrow override.

## Runbook

Commands run from the repo root; R2 creds via `infra/r2-run`.

### One-time migration (first promotion under B)

1. Deploy the new worker code with `CELLS_PREFIX` unchanged (`cells-e710a3c`, legacy layout): `cd cells-api && pnpm exec wrangler deploy --env dev`, CIC `dev.crashes.hccs.dev` map, then prod (`cells-api/deploy.dvc`). Behavior is unchanged except the D1-salted cache key.
2. Publish the current build into `cells/` (not live yet — nothing reads `cells/`): `infra/r2-run njdot compute cells push -n`, then `infra/r2-run njdot compute cells push` (36 server-side copies; writes `cells/manifests/s2-bce081312bad.json` and `cells/manifest.json`).
3. Flip `CELLS_PREFIX = "cells"` for `[env.dev.vars]`, deploy dev, CIC; then `[vars]`, deploy prod, CIC (`/v1/manifest` shows `data_version: s2-bce081312bad` and `shards`). This is the last deploy a data promotion needs.
4. After ≥48 h: `infra/r2-run njdot compute cells gc -l` (review), then `-a -l` to drop `cells/`'s old fixed-name files; and delete the old prefixes by hand once nothing references them (`grep CELLS_PREFIX cells-api/wrangler.toml`): `infra/r2-run aws s3 rm --recursive s3://crashes/cells-e710a3c/` and `…/cells-dev/`.

### Every promotion after that

1. Build on Batch and commit/push the `.dvc`s + blobs (`dvx push -r r2`), as today.
2. `dvx pull data/cells/s2_pyramid.dvc data/cells/raw/s2_l21.dvc` (or run the next steps on Batch).
3. `infra/r2-run njdot compute cells push -n` → review → `infra/r2-run njdot compute cells push -A` (stage; prints `<v>`).
4. D1: today `d1-import.sh --inplace cells-s2` (daily already does this); once versioned tables land, import under `cells_s2_<v>_l` and pass `-d` to `cells push`.
5. `infra/r2-run njdot compute cells activate <v>`; within 60 s `/v1/manifest` shows `<v>`. CIC.
6. Rollback: `infra/r2-run njdot compute cells activate <previous v>` (retained ≥ 3 builds / 48 h).
7. Periodically: `infra/r2-run njdot compute cells gc` → `-a`.

## Open

- D1 versioned-table import + `cells gc --d1` (above); then decide the daily `cells-s2` import.
- `cells push` could run copy-only from the committed `.dir` (no local pull) by skipping `put_shard`'s payload hashing; kept the local-bytes path to reuse the pyrmts protocol as-is.
- Swap `cells_publish.gc`'s loop for `pyrmts.gc` and drop the uv override when pyrmts's spec lands.
