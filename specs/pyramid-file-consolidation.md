# Pyramid file-count re-arch: consolidate fine shard tiers

## Problem

The cells pyramid (`data/cells/pyramid/`, mirrored to
`s3://nj-crashes/cells/pyramid/`) is **~337k files / ~5 GB** after the
r15+sld build (`specs/done/cells-api-r15-pyramid.md`). File count is
driven entirely by `shard_res` — one parquet per r`{shard_res}` cell in
NJ that holds data — and the fine tiers dominate:

| shard tier | shards/combo | combos | files | bytes | avg/file |
|---|---|---|---|---|---|
| s9 | 78,379 | 3 (r12,r13,r14) | 235,137 | ~2.8 GB | 11.8 KB |
| s8 | 20,434 | 4 | 81,736 | 1.15 GB | 14 KB |
| s7 | 4,123 | 4 | 16,492 | 421 MB | 25.5 KB |
| s2–s6 + simple `rN` | ≤812 | — | ~3,300 | ~700 MB | — |

(`s9_r15` was already dropped in the r15 spec — picker caps r15 at s8.)

**The waste is per-file parquet overhead.** An s9 shard holds ~30 rows
but its file is a median **11 KB** — the actual payload (counts + a few
`topK` structs + 4 sld strings for ~30 cells) is ~1–2 KB; the rest is
fixed overhead: footer, per-column-chunk headers, and dictionaries for
the `topK` nested-struct + sld string columns, **paid once per file**.
So the s9 tier is ~2.8 GB of mostly-overhead for 235k tiny objects.

Costs of the file explosion:
- R2 object count (PUT costs on every rebuild; a full re-push is ~30 min).
- `manifest.json` lists every combo's `shard_cells` → ~9 MB and growing;
  fetched by every client + held in every worker isolate.
- Storage: ~3.5 GB is overhead, not data.

## Options

### 1. Drop the whole s9 tier (r12/r13/r14)

Delete `pyramid/s9_r{12,13,14}`, regen manifest, `cells push` with
`--delete`. s8 becomes the finest `shard_res` for those data_res.

- **Savings**: −235k files, −2.8 GB, manifest ~9 MB → ~3 MB.
- **Client impact**: `pickCover` (`www/src/map/useCellsApi.ts`) refines
  to the finest published `shard_res` for boundary/overhang fit, capped
  at `maxRes`. Dropping s9 makes `maxRes=8` for r12–r14, so deep-zoom
  fetches use s8 shards (~115 rows) instead of s9 (~30 rows): **fewer**
  HTTP requests, marginally more off-viewport bytes per boundary shard
  (bounded, ~1 s8 shard's worth). Net likely a win.
- **Verify before shipping**: at the zooms that request r12–r14, confirm
  `pickCover` returns a sane cover (< `COVER_MAX_SHARDS=80`) with s8 as
  finest, and per-shard fetch sizes stay small.
- **Risk**: low. Pure sharding change; data identical.

### 2. Row-group consolidation (raw-path pattern)

Keep fine fetch granularity but collapse physical files: store one
parquet per **coarse** shard (e.g. s5 or s6) containing row-groups keyed
by the finer shard cell, h3-sorted, and have the worker **range-read +
prune by row-group stats** — exactly what the raw path already does
(`raw/h3_r{base}/{r4}.parquet`, h3-sorted row groups; see
`queryRaw` + hyparquet range fetching in `cells-api/src/parquet.ts`).

- **Savings**: collapse ~337k → ~16k physical files while preserving
  per-fine-cell pruning. Overhead amortizes across row-groups in one
  footer.
- **Cost**: real worker + pipeline change. Worker's combo path becomes a
  range-read with row-group selection instead of a whole-file read; the
  emitter writes multi-row-group files sharded at a coarser res. Loses
  per-shard-URL CDN cacheability (range requests are less cache-friendly
  than immutable per-shard URLs) — measure whether the current per-shard
  browser/edge cache hit-rate matters.
- **Risk**: medium. Touches the hot read path; needs careful row-group
  pruning tests.

## Recommendation

Do **#1 first** — it's low-risk, ~2.8 GB / 235k-file win, and a manifest
shrink, with a client-picker verification gate. Treat **#2** as a
larger, separate effort only if per-file overhead still matters after #1
(it mostly won't — post-#1 the pyramid is ~2 GB / ~100k files,
dominated by s8 which amortizes overhead far better than s9).

## Non-goals

- Not changing counts/topK/sld semantics — this is purely how shards are
  physically laid out.
- Not touching the raw path (already row-group-structured).

## Rollout (option 1)

```bash
# on e
rm -rf data/cells/pyramid/s9_r12 data/cells/pyramid/s9_r13 data/cells/pyramid/s9_r14
env -u PYTHONPATH njdot compute cells manifest -b 15 -l 6,7,8,9,10,11,12,13
env -u PYTHONPATH njdot compute cells push          # NOTE: with --delete (drop orphan s9 objects from R2)
# worker unchanged; redeploy only to flush the cached manifest
cd cells-api && pnpm wrangler deploy
# verify pickCover at r12-r14 zooms returns s8-finest covers < 80 shards
```
