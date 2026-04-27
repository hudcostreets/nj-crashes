# Map data backend: H3 parent-cell sharding + multi-resolution prebins

> Status:
> - Phase 1 (pipeline): **done**. `njdot export_map_v2` generates `www/public/njdot/map/v2/` alongside the v1 tree; `map.dvc` cmd extended.
> - Phase 2 (client viewport-aware shard picker): pending.
> - Phase 3 (drop v1): pending.

## Motivation

The current static-parquet layout under `www/public/njdot/map/` is sharded by `(year, county)` for raw rows and by `(year)` for hex prebins:

```
map/
├── by-year/{year}.parquet
├── by-year-county/{year}-{cc}.parquet
├── hex-r7/{year}.parquet
├── hex-r8/{year}.parquet
└── manifest.json
```

This works for fixed admin queries ("Hudson, 2019-2023") but doesn't support the more general "fetch what's in this viewport" query that smooth multi-scale browsing needs. Concretely:

- Statewide hexbin currently has to choose between
  - Loading all of `by-year/{year}.parquet` (~6.5 MB for 5 yrs of fatal+injury) and re-binning client-side on every zoom — works but downloads everything regardless of view.
  - Or loading a single fixed-resolution prebin (`hex-r8/`), which produces a uniform-grid artifact at moderate zoom because crashes are sparse relative to cell size.
- There is no clean way to fetch "just the crashes intersecting this bbox" without enumerating every county the bbox crosses.
- We have only r7 and r8 prebins; r6 (whole-state overview) and r9 (zoomed-in detail without raw rows) are missing.

The fix is to **shard spatially by H3 parent cell** and to **publish prebins at every resolution we want to render at**. Client computes the parent cells covering the visible bbox and fetches only those shards.

## Output layout

Published to `www/public/njdot/map/v2/` (parallel tree; old layout stays until clients migrate):

```
map/v2/
├── points/{shardCell}.parquet       # raw f+i rows whose H3 r{shardRes} parent == shardCell
├── hex-r6.parquet                   # whole-state, single file (~600 cells)
├── hex-r7/{shardCell}.parquet       # r7 hex aggregates within parent
├── hex-r8/{shardCell}.parquet       # r8 hex aggregates within parent
├── hex-r9/{shardCell}.parquet       # r9 hex aggregates within parent
└── manifest.v2.json
```

### Shard resolution

Pick **r5 as the shard parent resolution**. Coverage of NJ envelope:

| res | cells covering NJ | rough cell radius |
|-----|-------------------|-------------------|
| r4  | 8                 | ~22 km            |
| r5  | 56                | ~8.5 km           |
| r6  | 369               | ~3.2 km           |

r4 is too coarse — fetching one shard pulls a quarter of the state. r6 makes too many tiny files (network-overhead-dominated). r5 lands ~50 shards covering NJ, each ~250 KB raw points / ~50 KB prebin — the sweet spot.

**Phase 1 actuals** (full 23 yrs, all severities throughout):
- 153 non-empty r5 shards for points
- 154 non-empty r5 shards for hex prebins
- average shard sizes: ~750 KB points (largest 8.5 MB in the Newark/Jersey City core), ~12 KB hex-r7, ~16 KB hex-r8, ~28 KB hex-r9

For `hex-r6`, all of NJ fits in ~750 r6 cells (one per `(h3, year, cc, mc)` tuple yields ~47K rows total → 308 KB). Single file, no sharding needed.

### Year as column, not file

Drop the year axis from the file path. Every shard contains all years (2001–present) with `year` as a column. Sort row groups by year so hyparquet's row-group-min/max filter pushdown skips irrelevant ranges efficiently.

This collapses ~23× more files into ~23× larger ones — but each fetch carries the full history when needed (typical: user expands year range without the client re-fetching).

### Severity / point coverage

Include all severities in raw points (`f`, `i`, `p`). The original spec proposed dropping PDO from points to keep raw-point storage small (~4× inflation), but at NJ's scale "4×" is 33 MB → 119 MB total — still trivial. Filtering happens client-side at fetch-time so the network cost is bounded by visible-shard count, not the on-disk total. Hex prebins continue to carry `n_pdo` for low-zoom views where raw points aren't loaded.

### Schema

`points/{shardCell}.parquet` rows: same columns as today's `by-year/{year}.parquet` (lat, lon, severity, year, cc, mc, case, dt, sri, mp, road, route, tk, ti, pi, pk, …) plus a derived `h3_r5` column (the shard cell) — included for sanity-checking, not required for queries since the shard key is in the filename.

`hex-r{N}/{shardCell}.parquet` rows: `h3` (resolution N), `year`, `cc`, `mc`, `n_fatal`, `n_ped_inj`, `n_other_inj`, `n_pdo`, `top_route` (per-cell mode of `road`/`route` weighted by total count, same as today's r8 prebins).

### Manifest

`manifest.v2.json`:

```jsonc
{
  "schema_version": 2,
  "shard_res": 5,
  "point_severities": ["f", "i"],
  "hex_severities": ["f", "i", "p"],
  "year_range": [2001, 2023],
  // Cells with non-empty data, per artifact:
  "shards": {
    "points":  ["852a107bfffffff", ...],
    "hex_r7":  ["852a107bfffffff", ...],
    "hex_r8":  ["852a107bfffffff", ...],
    "hex_r9":  ["852a107bfffffff", ...]
  },
  // Bounding box per shard cell (avoids client-side cellToBoundary on every pan):
  "shard_bboxes": {
    "852a107bfffffff": [w, s, e, n],
    ...
  },
  // Optional row counts for debugging/UX:
  "row_counts": { "points": 1040727, "hex_r6": 600, ... },
  // Keep legacy fields for back-compat / non-spatial UIs:
  "county_bboxes": { ... },
  "muni_bboxes": { ... },
  "by_geocode_src": { ... },
  "per_year": { ... },
  "per_year_county": { ... }
}
```

## Pipeline (runs on `e`)

Add a new exporter (e.g. `njdot export_map_v2`) that:

1. Reads `njdot/data/crashes.parquet` (geocoded, all years, all severities).
2. For each row, compute `h3_r{N}` for `N ∈ {5, 6, 7, 8, 9}`. Vectorize via `h3-py` or a custom UDF; ~6.5 M rows × 5 res should run in a few minutes.
3. Emit `points/{cell}.parquet` for each non-empty r5 parent cell, restricted to `severity ∈ {f, i}`, sorted by `(year, h3_r9)` so row-group pruning works for both year-range and bbox queries.
4. For each prebin resolution `N ∈ {6, 7, 8, 9}`:
   - Group by `(h3_r{N}, year, cc, mc)`, compute per-severity counts and `top_route`.
   - For r6: emit single `hex-r6.parquet`.
   - For r7-r9: shard by r5 parent → `hex-r{N}/{cell}.parquet`.
5. Build `manifest.v2.json` from the emitted file list + bboxes.
6. DVX-track the directory: extend `www/public/njdot/map.dvc`'s `cmd` to invoke the new exporter (or add a sibling `map.v2.dvc`).

Pre-existing helpers worth reusing:
- `njdot/export_map_data.py` (current pipeline) — model the new exporter on it.
- `njdot/gen_county_outlines` / `gen_muni_outlines` — unchanged, keep alongside.

Estimated total bytes published:

| artifact | spec estimate | actual (23 yrs, all severities) |
|----------|--------------:|--------------------------------:|
| `points/` (153 shards)      | ~25 MB | 111 MB |
| `hex-r6.parquet`            | ~50 KB | 308 KB |
| `hex-r7/` (154 shards)      | ~3 MB  | 1.8 MB |
| `hex-r8/` (154 shards)      | ~10 MB | 2.5 MB |
| `hex-r9/` (154 shards)      | ~30 MB | 4.2 MB |
| **total** v2                | ~68 MB | **119 MB** |

v1 + v2 coexist while client migrates: `map.dvc` outs grew 243 MB → 376 MB.

## Client (this repo)

`useCrashData.ts` adds a `viewport`-aware shard picker. Changes:

1. Replace `CrashFilter.scale: "detail" | "r8" | "r7"` with a richer plan derived from `(viewport, severities, zoom)`:

    ```ts
    type FetchPlan =
      | { kind: "hex"; res: 6 | 7 | 8 | 9; shards: string[] }   // shards = r5 parent cells
      | { kind: "points"; shards: string[] }
    ```

2. `pickFetchPlan(bbox, zoom, severities, manifest) → FetchPlan`:
   - If PDO selected and zoom is low: `hex-r6` or `hex-r7` (PDO only available via prebins).
   - If only fatal+injury and zoom ≥ pointZoomThreshold (~10) and visible-shard count ≤ N: `points` (raw rows, client-side bin per zoom).
   - Else: prebin at the resolution closest to `pickHexResolutionForPixels(...)`, sharded by visible parents.

3. `visibleShards(bbox, manifest) → string[]`: filter `manifest.shard_bboxes` by bbox intersection. Cheap; no `polyfill` call needed.

4. Debounce on bbox changes. Refetch only when the *set* of visible shards changes (not on every pan-pixel). Cache fetched shards by URL — common case (small pan within shard) hits cache.

5. `coarsenHexes` already handles "we have r9, want r7 visually" — so it stays useful when the planner gives us a finer prebin than the picker wants.

6. The planner can pick a coarser prebin directly (no `pickHexResolutionForPixels` floor needed; the function already considers all resolutions unfiltered).

## Migration / back-compat

Old layout stays under `www/public/njdot/map/` until v2 lands and the client switches over. Plan:

1. Phase 1 (this spec): `e` generates v2 alongside the existing tree. DVX adds a new tracked output (`map.v2.dvc` or extend `map.dvc`).
2. Phase 2: client reads `manifest.v2.json` and the new tree. Old code paths kept behind a feature flag for one deploy.
3. Phase 3: delete old layout and code paths. Update DVX.

## Open questions

- **r9 worth it?** Came in at 4.2 MB (way under the spec's 30 MB estimate), so the storage argument against it largely evaporates. Keep.
- **Should `hex-r6.parquet` carry per-county/per-muni breakdown columns?** Yes; included as `cc`/`mc` columns alongside the per-(h3, year) bin counts.
- **Single-file vs sharded for r7?** Sharded — 154 r5 parents, 1.8 MB total. Sharded keeps the "one schema for all prebins ≥ r7" rule and lets viewport queries skip non-visible shards.
- **PMTiles instead?** Industry-standard; would be cleaner long-term but a bigger lift (MVT/vector-tile rendering replaces deck.gl ColumnLayer; lose 3D-bar control). Defer; revisit if static parquet hits a wall.

## Phase 1 deliverables

- New CLI: `njdot export_map_v2` (`njdot/cli/export_map_v2.py`) — reuses `_build_base` from the v1 exporter for column projection / lat-lon resolution.
- `www/public/njdot/map.dvc`: `cmd` extended to chain `njdot export_map_v2`; outs md5 refreshed to cover the new `map/v2/` subtree.
- `www/public/njdot/map_sync.dvc`: dep md5 updated so `aws s3 sync` picks up the new tree.
- Pipeline runtime on `e`: ~5 min (h3 cells: ~37s for 5 resolutions × 4M rows; r9 hex aggregate is the long pole at ~150s due to per-bin `top_route` mode via `groupby.apply`).
- Public S3 mirror: `https://nj-crashes.s3.amazonaws.com/njdot/map/v2/...` (CORS + range-request enabled; verified `Accept-Ranges: bytes`).

### `manifest.v2.json` schema (as emitted)

```jsonc
{
  "schema_version": 2,
  "shard_res": 5,
  "point_severities": ["f", "i", "p"],
  "hex_severities":   ["f", "i", "p"],
  "year_range": [2001, 2023],
  "shards": {
    "points": [<r5 cells, 153>],
    "hex_r7": [<r5 cells, 154>],
    "hex_r8": [<r5 cells, 154>],
    "hex_r9": [<r5 cells, 154>]
  },
  "shard_bboxes": { "<r5cell>": [w, s, e, n], ... },
  "row_counts": { "points": 3978856, "hex_r6": 46703, "hex_r7": 118678, "hex_r8": 322941, "hex_r9": 722805 },
  // Legacy carry-overs (same shape as v1's manifest.json — present
  // here so a v2-only client doesn't need both manifests):
  "county_bboxes":  { "<cc>":      [w, s, e, n], ... },     // 21 entries
  "muni_bboxes":    { "<cc>-<mc>": [w, s, e, n], ... },     // 563 entries
  "by_geocode_src": { "interpolated": ..., "original": ... },
  "per_year":        { "<year>": <count>, ... },
  "per_year_county": { "<year>-<cc>": <count>, ... }
}
```

`hex-r6.parquet` is *not* listed in `shards` (it's a single file, not sharded — just fetch it directly).

### H3 cell sizes at NJ latitude (for planner thresholds)

| res  | flat-to-flat width | area      | typical landmark             |
|------|-------------------:|----------:|------------------------------|
| r4   | ~28 mi             | 683 sq mi | quarter of NJ                |
| r5   | ~10.6 mi           | 97 sq mi  | a county (Hudson = 47 sq mi) |
| r6   | ~4.0 mi            | 14 sq mi  | a town                       |
| r7   | ~1.5 mi            | 2.0 sq mi | a neighborhood               |
| r8   | ~3000 ft           | 0.28 sq mi| a few blocks                 |
| r9   | ~1140 ft           | 26 acres  | a building cluster           |
| r10  | ~432 ft            | 3.7 acres | a single building            |

Rough zoom mapping: r6 ≈ z9–10, r7 ≈ z11–12, r8 ≈ z13–14, r9 ≈ z15+. `pickHexResolutionForPixels` already does this comparison on a log2 scale; planner can reuse it.

### Largest point shards (for client perf budget)

The Newark / Jersey City / Hudson core has the densest data — top point shards (compressed parquet, all 23 yrs, all severities):

| shard cell        | size   | rough area         |
|-------------------|-------:|--------------------|
| `852a107bfffffff` | 8.5 MB | central Hudson Co. |
| `852a1047fffffff` | 8.4 MB | central Essex Co.  |
| `852a1073fffffff` | 7.2 MB | northern Hudson    |
| `852a100bfffffff` | 6.3 MB | Bronx/Bergen edge  |

A fully-zoomed viewport on Newark covers 1–2 of these → 8–17 MB on a fresh fetch. Acceptable on broadband, painful on cellular. Phase 2 client should: debounce viewport changes, cache fetched shards, and consider falling back to hex prebins (~100 KB) if visible-shard count × per-shard size exceeds a budget.

### Known gotchas for Phase 2

- **Re-runs are byte-idempotent.** With identical `crashes.parquet` input, two consecutive `njdot export_map_v2` runs produce bit-identical outputs across all 616 parquet files and `manifest.v2.json` (verified 2026-04-27, pyarrow 21.0.0). `aws s3 sync --delete` is a no-op when there's no upstream change. (An earlier draft of this spec claimed `pandas.to_parquet` was non-deterministic — that was a misattribution: the 617-file re-upload that prompted it was real content/order churn from the same commit's `year`-column add + hex `(year, h3)` sort, not metadata noise. Pyarrow parquet doesn't embed wall-clock timestamps and the exporter creates no categoricals, so neither stated mechanism applies.)
- **DVX `dvx run map_sync.dvc` does not work cleanly today.** Three upstream-DVX issues conspire (see [`~/dvx/specs/`][dvx-specs]): cwd resolution, walk-upstream overreach, `.dir` md5 asymmetry. Workaround: run `aws s3 sync map s3://nj-crashes/njdot/map --delete` directly from `www/public/njdot/`.

[dvx-specs]: ../../dvx/specs/

## For laptop, picking up Phase 2

Pull / fetch (not via GH; laptop pulls directly from `e`):
```
git fetch e && git merge --ff-only e/main
```

The v2 data is already live at `https://nj-crashes.s3.amazonaws.com/njdot/map/v2/`. No `dvx pull` needed — laptop can hit the public URL during dev.

Phase 2 starting points:
- `www/src/map/useCrashData.ts` — replace `CrashFilter.scale: "detail"|"r8"|"r7"` with `FetchPlan` (see "Client" section above).
- New util: `pickFetchPlan(bbox, zoom, severities, manifest) → FetchPlan` and `visibleShards(bbox, manifest)`.
- Manifest fetch: `${MAP_BASE_URL}/v2/manifest.v2.json` (toggle behind a feature flag for one deploy).

Recent deviations from the original spec (search this doc for "**Phase 1 actuals**" + "Severity / point coverage"):
- All severities now in raw points (PDO included, default `-s i,f,p`); client filters at fetch time.
- `manifest.v2.json` carries the full set of legacy fields (county/muni bboxes, etc.) so the client doesn't need v1's manifest.

## Phase 2 actuals (FE wiring landed; commit `e09327c537c`)

Initial client cut behind `?v2=1` flag:
- `www/src/map/v2.ts` (new) — `MapManifestV2` types, `loadManifestV2()` (single-flight, 404/HTML-fallback safe), `visibleShardsV2(viewport, manifest, artifact)`, `pickFetchPlanV2(...)`, `bboxFromViewport()`, `shardUrlV2()`, `POINT_COLUMNS` / `HEX_COLUMNS` projection lists.
- `www/src/map/useCrashData.ts` — v2 manifest probe + `v2Active`/`v2Plan` memos; `filterKey` keys on the resulting shard *set* so pans within a shard don't refetch; `v2Probed` gate prevents v1 + v2 from both firing on first load.
- `www/src/routes/CrashMapPage.tsx` — passes viewport/lat/zoom/hexPxTarget to `useCrashData` when `v2Enabled()`.

Verified bytes (instrumented `fetch` wrapper distinguishing HEAD vs GET 200/206):
- Newark zoom 17, 5-yr range, raw points, 1 shard → **1.6 MB** across 163 range GETs.
- State zoom 8, 23-yr hex view → **3.2 MB** across 154 r7 shards (picker tuning issue: should snap to single-file r6 = 308 KB; see follow-up below).

### Phase 1 deviations from the published schema discovered during FE wiring

1. **Points shards have `dt` (epoch minutes) but no `year` column.** ~~Spec line 68 lists `year` among the projected columns.~~ **Resolved**: `year` (int16) is now present alongside `dt`; row-group min/max stats are tightly year-bounded (typical RG covers 1 year), so a `year`-range filter pushes down without the FE having to derive bounds from `dt`.
2. **Hex shards (r7/r8/r9) row groups are NOT year-sorted.** **Resolved**: `_hex_aggregate` now `sort_values(["year", "h3"])` before write. Hex shards with ≥2 RGs (the 26 largest r9 shards, 2 r8, 0 r7, plus the single hex-r6 file with 5 RGs) now have year-bounded RG stats, so `canSkipRowGroup` prunes year-out-of-range RGs. Smaller shards remain single-RG (file size 50–150 KB makes pruning irrelevant).
3. **`points/{cell}.parquet` files include all 19 columns** — including `case`, `geocode_src`, `cross_street`, `road`, `route`, `sri`, `mp`. Client projects to a 10-column subset (`POINT_COLUMNS = [lat, lon, severity, dt, tk, ti, pk, pi, tv, … ]`) for typical render+tooltip needs. Tooltips needing `road`/`route`/`cross_street` can refetch with a wider projection; current implementation skips those entirely. *No backend change needed.*

### Phase 2 follow-ups (FE-side)

- **Picker snaps to fine prebins at low zoom.** **Resolved**: `pickFetchPlanV2` now falls back to `hex_r6` single-file (~400 KB raw, ~50 KB after pushdown) when the picked r7/r8/r9 prebin would require more than `maxHexShards = 10` viewport-intersecting shards. State-zoom-8 used to fan out across 154 r7 shards (~2.5 MB + ~3000 range GETs); now collapses to one parquet. Fine-grained prebins remain in play whenever the viewport is small enough that ≤10 r5 parents intersect.
- **Note on `PREBIN_MIN_PX`**: earlier spec drafts referenced a floor in `pickHexResolutionForPixels` to be dropped — the floor was never landed (the function already iterates r5–r13 unfiltered), so no code change needed.
- ~~**Collapse `CrashFilter.scale: "detail"|"r8"|"r7"` into the v2 `FetchPlan`.**~~ **Resolved**: `scale` field removed from public `CrashFilter` type; `useCrashData` derives v1 scale internally via `v1Scale(filter)`. v2 path uses `FetchPlan` (kind+res); render branches on `dataKind`. Pages no longer thread a `scale` value back into the filter they construct.
- **Severity filter pushdown on `points/`** — `severity` is a string column, possibly worth indexing for `severity ∈ {f, i}` queries that exclude PDO. Marginal; defer until profiling.

### Known gotchas for Phase 2 (continued)

- **Cross-origin S3 fetches don't expose `transferSize`** in `PerformanceObserver` because S3 doesn't emit `Timing-Allow-Origin`. Use a `fetch` wrapper to count bytes by `Content-Length` if you need to instrument transfer size in-page; remember to filter out HEAD probes (their `Content-Length` reports the full file size but no body is transferred).
- **Hyparquet emits 1 HEAD + ~50–200 range GETs per shard.** That's how parquet column-page reads work — many small fetches (5–30 KB each). Total bytes are low; round-trip latency dominates over a slow network. Per-shard cache (existing `shardCache` in `useCrashData.ts`) makes repeated reads free.
