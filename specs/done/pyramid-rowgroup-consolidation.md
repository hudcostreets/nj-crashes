# Pyramid consolidation: coarse shards + h3 row-group pruning

Supersedes `pyramid-file-consolidation.md` (whose s9-drop is now a fallback,
not the plan).

## Problem

The pyramid is **336,664 files / 5.0 GB**. File count is driven entirely by
the fine `s{shard_res}` tiers — one parquet per shard cell:

| tier | files | GB | KB/file |
|---|---|---|---|
| simple `rN` (r4-sharded) | 248 | 0.28 | 1096 |
| s2–s6 | 3,051 | 0.41 | — |
| s7 | 16,492 | 0.42 | 25 |
| s8 | 81,736 | 1.15 | 13.7 |
| s9 | 235,137 | 2.77 | **11.5 (~80% overhead)** |

An s9 file holds ~30 rows (~1–2 KB payload) in an ~11.5 KB file — the rest is
per-file parquet overhead (footer + dict pages), **paid once per file**.

The fine tiers exist to bound **over-fetch at deep zoom**: a small shard ≈ the
viewport, so the client fetches little off-screen data. The simple r4-sharded
levels already avoid the file explosion (34 files/level) but a whole r4 shard
at r13 is ~69k rows — too much to read per deep-zoom pan, which is *why* the
fine tiers were added.

## Insight

**Row-group pruning gives both few files AND tight fetch.** Store one file per
**coarse (r4)** shard, h3-sorted, split into row-groups; the worker fetches
only the row-groups overlapping the viewport. hyparquet already supports this:
`parquetPlan` → `canSkipRowGroup` skips a row-group when the filter's range
doesn't overlap the group's column **min/max statistics** — so skipped groups'
bytes are never fetched (verified in hyparquet 1.25.6 source). `$or` of ranges
is handled correctly (skip iff the group overlaps *none* of the ranges).

Since h3 stores resolution digits in fixed bit positions, the descendants of a
cover cell `C` (res `S`) at data_res `R` form a **contiguous integer range**:

```
base = (C with resolution field set to R)         # digits S+1..15 already = 0b111
lo   = base with digits S+1..R zeroed             # 000…, digits R+1..15 = 111
hi   = base                                        # 111…, i.e. ≥ every real descendant
```

Every res-R descendant `D` of `C` has digits `S+1..R ∈ 0..6`, digits `R+1..15 =
0b111`, so `lo ≤ D ≤ hi`; any non-descendant differs in a digit `≤ S` (higher
bits) so falls outside `[lo,hi]`. Exact, no extra column, no h3 lib call.

## End state (single read path — no dual-mode worker)

- **Layout**: `pyramid/r{R}/{r4}.parquet` for every data_res `R` (r6–r15),
  h3-sorted within each r4 shard, `row_group_size ≈ 4096` (smaller than the
  raw 20k → finer pruning; footer overhead is now negligible with ~34
  files/level). sld + topK baked, same columns as today's combos.
- **The `s{S}_r{R}` combos and the old `pyramid/r{N}/` simple levels are both
  deleted** and replaced by this one layout.
- **Worker** (`queryPyramid`): read the r4 shards overlapping the cover; for
  each, `filter: { $or: coverCellsUnderThisR4.map(C => ({ [h3_rR]: {$gte:
  lo(C,R), $lte: hi(C,R)} })) }`. Cover cells coarser than r4 (wide zoom, small
  coarse levels) → read all r4 shards for the level (cheap). One read path;
  the `s{S}_r{R}` branch is removed.
- **Client** (`pickCover`/request): still computes a multi-res cover; sends
  `cells=<cover>&res=R` (no `shard_res`). Worker derives r4 files (cover cells'
  r4 parents) and per-file prune ranges. `COVER_MAX_SHARDS` now bounds cover
  *cells* used for pruning, not files fetched.
- **Manifest**: drop `pyramid_combos`; publish the plain `pyramid_levels` list
  (already present). File count ~2–3k.

## Expected result

336,664 → ~2,000–3,000 files; 5.0 GB → ~2 GB (overhead amortized across
row-groups in one footer per r4 shard). No UX regression: pruning preserves
per-viewport fetch tightness. Rebuild + push far cheaper (2–3k objects).

## Confidence / the one empirical check

Correctness of pruning is settled by the h3 bit-layout + hyparquet source
above. The only empirical question is **how tight** the fetch is in practice
(bytes/row-groups per request vs today's s8/s9). Validate by generating **one
level first** (r13 — the worst case), pointing the worker at it locally
(`wrangler dev` / vitest), and measuring fetched bytes + latency for a few
representative deep-zoom covers before rebuilding all levels.

## Rollout

1. Emitter: `_build_pyramid_level` at `shard_res=4` + sld for r6–r15,
   `row_group_size≈4096`; parallelize across levels (fork pool, COW `base`).
2. Build **r13 only**; worker prune path; local measure. Gate.
3. Build all levels; regen manifest (drop combos); build cover→prune worker +
   client changes; worker tests (prune correctness + missing-shard).
4. Blue-green cutover: write new `pyramid/` under a staging prefix or rebuild
   in place + deploy worker + `push --delete` old combo/simple dirs. Verify
   live. Delete old.
5. Drop orphaned `raw/h3_r14`; update `.dvc`; one `dvx push` on the lean
   pyramid; commit; move this spec to `specs/done/`.

## Non-goals

- Not changing counts/topK/sld semantics — purely physical layout + read path.
- Not touching the raw path (already r4-sharded; could later gain the same
  h3-range pruning, but it's the rarely-hit fallback).

## Outcome (implemented)

- **Pyramid: 336,664 files / 5.03 GB → 340 files / 0.46 GB** (990× fewer, 11×
  smaller); r14/r15 now first-class levels (previously r14 was s9-only).
- **Manifest: 9 MB → 1.1 KB** (only `pyramid_levels`, no combos).
- Empirical pruning (`consolidated.test.ts`, real r13 bytes): a viewport cover
  fetches **~3–4% of an r4 shard**. Footer = 264 KB (68% of a minimal fetch) —
  the fixed per-request cost; RG=4096 is near the √-optimum (~6000), curve flat
  ±6% over 4k–8k.
- Cutover was **in-place, no hard-down window** (blue-green unneeded): the new
  layout lives at disjoint keys (`pyramid/r{N}/` vs `pyramid/s{S}_r{N}/`), the
  new worker is backward-compatible with the deployed client (`shard_res`
  ignored; cover cells → prune ancestors), and a transition manifest
  (levels 6–15 + combos) satisfied both workers until the combos were dropped.
- Deployed (worker `53f8e86d`), verified live at r13/r14/r15. Orphaned
  `raw/h3_r14` dropped (base is r15). `pyramid.dvc` re-tracked (`dvx add` +
  `push`, cache now 0.46 GB).

## Deferred follow-ups (not needed for the cutover)

- **Worker footer caching**: cache parsed `FileMetaData` per r4 key in the
  isolate so repeated pans over a region don't re-fetch the 264 KB footer.
  Higher-value than any grouping-size retune.
- **Client `pickCover` simplification**: the client still sends one request per
  `shard_res` tier (each now re-reads the same r4 files with a different prune
  range). Collapse to a single request; drop the `shard_res` param.
- **RG-size retune**: optional; flat optimum, low value.
