# Map data backend: H3 parent-cell sharding + multi-resolution prebins

> Status: spec; ready for `e` to implement the pipeline. Client wiring to follow once new layout is generated.

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

For `hex-r6`, all of NJ fits in ~600 r6 cells, ~50 KB total. Single file, no sharding needed.

### Year as column, not file

Drop the year axis from the file path. Every shard contains all years (2001–present) with `year` as a column. Sort row groups by year so hyparquet's row-group-min/max filter pushdown skips irrelevant ranges efficiently.

This collapses ~23× more files into ~23× larger ones — but each fetch carries the full history when needed (typical: user expands year range without the client re-fetching).

### Severity / point coverage

Keep `point_severities = ['f', 'i']` (fatal + injury raw rows). Adding PDO points would inflate raw-point storage ~4×; PDO consumers should use the prebins, which carry `n_pdo` in every cell.

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

| artifact | size |
|----------|------|
| `points/` (50 shards × 5 yrs of fatal+injury extrapolated to 23 yrs) | ~25 MB |
| `hex-r6.parquet` | ~50 KB |
| `hex-r7/` (50 shards) | ~3 MB |
| `hex-r8/` (50 shards) | ~10 MB |
| `hex-r9/` (50-200 shards) | ~30 MB |

Roughly the same total bytes as today, but addressable per-viewport.

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

6. The `pickHexResolutionForPixels` floor-at-`PREBIN_MIN_PX` hack is no longer needed once the planner can choose a coarser prebin.

## Migration / back-compat

Old layout stays under `www/public/njdot/map/` until v2 lands and the client switches over. Plan:

1. Phase 1 (this spec): `e` generates v2 alongside the existing tree. DVX adds a new tracked output (`map.v2.dvc` or extend `map.dvc`).
2. Phase 2: client reads `manifest.v2.json` and the new tree. Old code paths kept behind a feature flag for one deploy.
3. Phase 3: delete old layout and code paths. Update DVX.

## Open questions

- **r9 worth it?** Adds ~30 MB of files. Useful when fatal+injury point fetch isn't available (PDO selected) but you want fine zoom. If not, drop and let `coarsenHexes` adapt r8 upward only.
- **Should `hex-r6.parquet` carry per-county/per-muni breakdown columns?** Useful for the homepage NJSP/NJDOT comparison sidebar; cheap to include. Recommend yes.
- **Single-file vs sharded for r7?** ~3 MB for all NJ. Could go either way. Single file simplifies fetch; sharded keeps the "one schema for all prebins ≥ r7" rule.
- **PMTiles instead?** Industry-standard; would be cleaner long-term but a bigger lift (MVT/vector-tile rendering replaces deck.gl ColumnLayer; lose 3D-bar control). Defer; revisit if static parquet hits a wall.
