# Map data backend (Path 1: static parquet + hyparquet)

Goal: serve interactive crash maps for any combination of (county | municipality | statewide) × (date range) × (severity filter) across the full NJDOT history (2001–present), with zoom-adaptive density aggregation — using only static files on CF Pages (no runtime compute).

Motivation: current `/map/hudson` hard-codes Hudson County 2019-2023 injury+fatal from a single 1MB reduced-JSON blob. To generalize, we need an indexed, layered store.

## Data source

Input: `njdot/data/crashes.parquet` — 6.5M rows, 2001-2023, with geocoded `(ilat, ilon)` from SRI/MP interpolation and `(olat, olon)` original. Plus severity `(f|i|p)` and victim counts `(tk, ti, pk, pi, tv)` and geo fields `(cc, mc, case, sri, mp)`.

For the map, prefer `ilat/ilon` (interpolated; more consistent) with fallback to `olat/olon` where `ilat` missing. Current coverage 2019-2023: 82-94%.

## Output layout

Published to `www/public/njdot/map/`:

```
map/
├── by-year/
│   ├── 2001.parquet     # all NJ, severity=p|i|f, with lat/lon+cc/mc/etc.
│   ├── ...
│   └── 2023.parquet
├── by-year-county/
│   ├── 2001-01.parquet  # Atlantic 2001
│   ├── ...
│   └── 2023-21.parquet  # Warren 2023
├── hex-r7/              # pre-aggregated, coarse (zoom < 10)
│   ├── 2001.parquet     # columns: h3, year, cc, mc, fatal, pedInj, otherInj, pdo
│   └── ...
├── hex-r8/              # medium (zoom 10-12)
│   └── ...
└── manifest.json        # bbox per county/muni, row counts, min/max date
```

Estimated sizes:

- 2019-2023 injury+fatal, statewide: ~250K rows → **~5 MB** parquet
- Full NJ all-severity 2001-2023: 6.5M rows → ~130 MB parquet (too big for one file)
- Per-year shards: 100-300K rows each → 2-8 MB per file
- Per-year-county shards: 1K-30K rows each → 50KB-600KB
- Hex-r7 aggregates (2001-2023): ~10K cells × 23 years × severity tiers → ~1-2 MB total
- Hex-r8 aggregates: ~50K cells × 23 years → ~5-10 MB total

## Client access pattern

`CrashMap` decides which parquet(s) to fetch based on the current view:

1. **Zoom < 10** (statewide, multi-county): fetch `hex-r7/{year}.parquet` for years in the selected date range. Render stacked hex columns with server-side aggregates.
2. **Zoom 10-12** (county/cluster of munis): fetch `hex-r8/{year}.parquet` OR `by-year-county/{year}-{cc}.parquet` when geo filter is a single county.
3. **Zoom 13+** (muni/neighborhood): fetch individual crash points via `by-year-county/{year}-{cc}.parquet`, optionally filter in-memory by `mc`.

All fetches go through `hyparquet` which does HTTP range reads on parquet row groups, so even `by-year/{year}.parquet` (a "fat" file) only transfers the rows/columns the client actually needs via parquet statistics filtering.

## Columns (by-year & by-year-county)

```
dt           : int64 (epoch minutes) — keep small
cc           : uint8
mc           : uint8
case         : string (dictionary-encoded)
tk           : uint8
ti           : uint8
pk           : uint8
pi           : uint8
tv           : uint8
severity     : enum(f, i, p)
route        : string? (dictionary)
mp           : float32 (nullable)
sri          : string? (dictionary)
lat          : float32
lon          : float32
geocode_src  : enum(interpolated, original, none)  # provenance
```

Per-row-group statistics on `dt`, `cc`, `mc`, `severity` let hyparquet skip row groups outside the filter. Target row group size: 10-50K rows (parquet default 128MB → reduce for fine-grained filter pushdown).

## Columns (hex-r7 / hex-r8)

```
h3           : string (15-char H3 index)
year         : int16
cc           : uint8
mc           : uint8
n_fatal      : int32
n_ped_inj    : int32
n_other_inj  : int32
n_pdo        : int32
n_tk         : int32
n_ti         : int32
```

One row per (h3, year, cc, mc). Client sums across years in the selected date range, then passes to the stacked-hex layer.

## Implementation

### Phase 1 — data generation
`njdot/cli/export_map_data.py`:
- Load `crashes.parquet` + compute effective `lat, lon, geocode_src`
- Write `by-year/{year}.parquet` (all severities, with small row groups)
- Write `by-year-county/{year}-{cc}.parquet`
- Compute H3 indices via `h3.api.numpy_int` at r7 and r8 for every geocoded crash
- Group by (h3, year, cc, mc) and emit `hex-r{7,8}/{year}.parquet`
- Emit `manifest.json` with bbox + row counts

Wire as a DVX stage depending on `crashes.parquet`:
```yaml
# www/public/njdot/map.dvc
cmd: njdot export_map_data -o www/public/njdot/map/
deps:
  /njdot/data/crashes.parquet
outs:
  www/public/njdot/map/manifest.json
  www/public/njdot/map/by-year/
  www/public/njdot/map/by-year-county/
  www/public/njdot/map/hex-r7/
  www/public/njdot/map/hex-r8/
```

### Phase 2 — client data layer
`www/src/map/useCrashData.ts`:
- Takes `{ cc?, mc?, yearRange: [y0, y1], severity: Set<'f'|'i'|'p'>, mode, zoom }`
- Computes which parquet URLs are needed
- Fetches via `hyparquet` (already in deps) with column projection + row-group filtering
- Returns typed `Crash[]` or `StackedHex[]`
- Memoizes on filter keys; incremental fetch when date range expands

### Phase 3 — CrashMap integration
- Replace the direct `crashes` prop with `useCrashData(filter)`
- Filter controls: `YearRangeSlider`, `SeverityToggle`, re-use the existing `ModeToggle`/`HexControls`
- On pan/zoom beyond the currently-loaded bbox, fetch adjacent shards
- When zoom crosses aggregation threshold (10, 12), switch layer backing

### Phase 4 — embed per-geo
- `<CrashMap cc={} mc={} />` reusable from Home.tsx county/muni pages
- Fit bounds from `manifest.json`
- Default year range = last 5 years

## Staging

1. (forum-critical) Phase 1 export + Phase 2 client layer for the statewide / injury+fatal slice, limited to 2019-2023. Serve the Hudson and a few other example views.
2. (forum-stretch) Phase 3 full filter controls.
3. (post-forum) Phase 4 embeds on Home.tsx for county/muni pages.
4. (post-forum) Extend to include PDO crashes (triples data size; lowest-priority severity).
5. (post-forum) Time dimension in h3 aggregates (month-level buckets for finer date filtering at low-zoom).

## Open questions

- Browser memory: loading 250K `Crash` objects is fine for DeckGL but React state with decoded objects may churn. Consider keeping data in `Uint8Array`-backed typed-array views to avoid per-row object allocation. Deck.gl's `ScatterplotLayer` can consume binary attributes directly — big perf win for 100K+ points.
- Row group sizing: need to experiment. Smaller = more filter pushdown but more HTTP overhead.
- H3 resolution choice at each zoom: current thresholds (9 < 10 → r7 etc.) in `CrashMap::zoomToH3Resolution`. Should match server pre-agg resolutions.

## References

- Current reduced-JSON pipeline: `nj_crashes/_json.py::reduce_df`, `tmp/regen_hudson_map.py`
- Hyparquet: `www/node_modules/hyparquet/` — supports `asyncBufferFromUrl` for HTTP range reads
- H3: `www/node_modules/h3-js/` — `latLngToCell`, `cellToBoundary`
