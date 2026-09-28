# Map mobile performance (heatmap / points / bins) + narrow-layout overlap

Status: **implemented on branch `map-mobile-perf`, not deployed** (2026-09-28). Rounds 2-3 below.

## Report

On an Android phone, [`/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013`][dev-view] on the dev deploy was "unusably slow" panning and changing years; the settings panel (Points/Heatmap/Bins, render Legacy/B/A/C, debug) overlapped the title bar's year selects; and the heatmap showed no basemap.

## Method

- **Worker**: `Server-Timing` on `/v1/cells` (new, see below), measured with curl against the deployed dev worker and against the branch worker run locally (`wrangler dev` in local workerd with a `remote = true` R2 binding on the real `crashes` bucket, prefix `cells-dev`, no D1 — the same data/config as `cells-api-dev`). Local numbers include laptop↔R2 latency, so they're for A/B, not absolute.
- **Client**: [`www/scripts/mobile-perf.mjs`][perf-script] — Playwright headless Chromium emulating a 390×844 DPR-2.75 touch phone with **4× CPU throttling**; load → pan 300 px → pan 400 px → zoom in → year change ×3, reporting per step the `/v1/cells` requests (bytes, duration, Server-Timing), long tasks, rAF frame intervals, and time-to-settle. On macOS headless Chromium renders WebGL on the real GPU (`ANGLE Metal Renderer: Apple M4`), so GPU stalls are visible — but an M4 GPU is far faster than a mid-range Android GPU, so GPU-bound numbers are a *lower bound*. No physical Android device was available.
- **CIC** (HCCS Chrome profile) for visual checks; its tab reported `visibilityState: hidden` (window not foreground), so rAF-based timings from CIC were unusable — hence the Playwright harness.

## Root causes

### 1. Legacy `HeatmapLayer` re-aggregation: 330-680 ms GPU stalls per pan (the "unusably slow")

Heatmap mode's default strategy is deck.gl's `HeatmapLayer`, whose fixed **2048² float weights texture** is re-rendered whenever a pan leaves its bounds or the zoom changes: every point is splatted with additive blending, then a max-reduction pass treats all 4M texels as points. In the phone harness, *with no long tasks at all*, pan frames had p95 **334-683 ms** (max 683 ms) at 1× and 4× CPU alike — i.e. GPU-bound, on an M4. `?hr=b` and Points mode on the same data: p95 18 ms, max 19-33 ms. On a phone GPU this is seconds per pan.

**Fix:** `weightsTextureSize` sized to the map (`heatmapWeightsTextureSize`: next power of two ≥ half the longer CSS side, in [256, 2048] → **512 on a phone** (16× fewer texels), 1024 on a 1480 px desktop). The kernel is 30 px, so ½ texel per CSS px is visually lossless. Pan frames → p95 **18-19 ms**, max 19-35 ms.

### 2. Year changes always refetched; each fetch paid for labels the heatmap never shows

Every year-select change built a new URL → a full `/v1/cells` round trip (0.5-1.5 s) plus a 500 ms debounce. And at l≥18 the request carried `labels=full` + `fatal_years` + 7 count columns: **443 KB JSON** for the phone view (labels were ~45% of it) — yet Heatmap has no tooltip.

**Fix:** a *lean* fetch for Heatmap mode (`leanCells.ts`, `useCellsApi(…, { lean: true })`): `format=cols` with only the four severity counts, and — new worker capability `group_year` — **one per-(cell, year) response over all years + severities** that the client re-aggregates for any year sub-range / severity set (`aggregateLean`). Year and severity changes: **0 requests, 0 ms**. A full-range filter (the default view) keeps the plain all-years request so prod's D1 rollup still serves it; the first sub-range change fetches the per-year table.

### 3. Phones asked for as many cells as desktops

`autoCellPxTarget` sizes cells as `√(area / BINS_BUDGET)` with a fixed 100k budget — a fixed cell *count*, so a 390×844 phone got ~1.4 px cells: **l19** at z14.5 in Jersey City (a 1480 px desktop gets l18). For the legacy heatmap (30 px kernel) anything below ~5 px is invisible.

**Fix:**
- `viewportBinsBudget`: the budget scales with viewport area below the 1280×480 embed it was tuned on (phone full-screen: 53.6k), so phones hold the embed's on-screen cell size. Every desktop view (≥ 1280×480) picks exactly as before.
- `maxCellsFor`: the per-request `maxCells` backstop is 1.5× that budget (phone 80k; desktop unchanged at 150k), and is now part of the per-shard cache key.
- `HEAT_LEGACY_MIN_CELL_PX = 5`: legacy Heatmap floors the fetch's cell size (Bins/Points/A/B/C keep the budgeted target). Phone z14.5: **l19 → l18** (4× fewer cells).

### 4. Worker: 54-91 R2 GETs per request, no edge cache

- hyparquet plans one byte range **per column chunk** when `columns` is set (it only merges runs for all-column reads). With 9 projected columns the phone view issued **54-91 R2 GETs**, summing 4-15 s of GET time; a Worker holds ≤6 subrequests open, so they queue. **Fix:** `coalescingBuffer` batches each synchronous burst of slices into merged GETs (64 KB max gap): **6-10 GETs**, one parallel wave (256 KB gap → 2 GETs but 735 KB read vs 106 KB; 64 KB chosen).
- A Worker's own responses never enter CF's CDN cache — `Cache-Control` only reached the browser — so the same URL re-ran the full read every time (curl ×3: **1.6-1.8 s each**). **Fix:** `caches.default` keyed on the param-sorted URL + `data_version` (`cellsCacheKey`), 7-day TTL on the stored copy (the key embeds `data_version`, so a pipeline push invalidates). Hits: **0-4 ms** worker time.
- `cellInPolygonS2` ran once per (cell, year) *row* (25× per cell on all-years reads); now memoized per token (`polygonTester`).
- Remaining fixed cost: a cold isolate's first read of a level file pays **300-600 ms** for HEAD + footer (per-isolate LRU footer cache already exists).

### 5. Dev payload 2.4× prod: data, not code

The same desktop URL (`res=18&years=2011-2013`, Jersey City) was 977 KB on dev vs 404 KB on prod. Bytes/cell are identical (212 vs 214); the **cell count** differs: 4716 vs 1933. The dev worker serves the new cells build (`cells-dev`, recovered crash points), and the recovery is concentrated in pre-2017 years (older crashes more often lacked coordinates). Same viewport, `labels=nums`:

| years | cells dev / prod | crashes dev / prod |
|---|---|---|
| 2001-2003 | 4111 / 1615 (2.55×) | 27993 / 13779 (2.03×) |
| 2008-2010 | 4414 / 2194 (2.01×) | 22573 / 10728 (2.10×) |
| 2011-2013 | 4716 / 1933 (2.44×) | 24552 / 12958 (1.89×) |
| 2014-2016 | 4865 / 2145 (2.27×) | 26868 / 13223 (2.03×) |
| 2017-2019 | 4831 / 3580 (1.35×) | 29598 / 22467 (1.32×) |
| 2020-2022 | 4930 / 4841 (1.02×) | 23232 / 22875 (1.02×) |
| 2023-2025 | 8290 / 8283 (1.00×) | 25655 / 25620 (1.00×) |

(The deployed prod worker also predates `format=cols` — it answers `format=cols` requests in rows — so prod-vs-branch worker code differs too, but not in a way that changes this response.)

### 6. Basemap missing on `crashes-www-dev.hccs-ctbk.workers.dev`: Stadia domain auth, not a regression

Prod builds ship no Stadia key and rely on Stadia's browser-enforced domain allowlist. A tile request with that host as `Referer`/`Origin` gets **401**; `crashes.hccs.dev`, `dev.crashes.hccs.dev`, `crashes.hudcostreets.org`, `localhost`, `127.0.0.1` all get 200 (no referer at all: 401). Not maplibre 6 / style URL. **Action (Stadia dashboard, not code):** add `crashes-www-dev.hccs-ctbk.workers.dev` (or `*.hccs-ctbk.workers.dev`) to the allowed domains, or test on `dev.crashes.hccs.dev`.

### 7. Settings panel over the title / year selects at phone widths

The full-screen title pill is centered (`left: 50%`) and the drawer is pinned top-right, both at `top: 8`; at 360/390/430 px they overlapped (title `[98,8,293,57]` vs drawer `[172,8,382,109]` at 390), and the pill also ran under the "NJ Crashes" home link. **Fix** (`mapChrome`, below 640 px): home link → icon only; title pill pinned between it and the ⚙/↺ buttons (wraps to two lines); legend and the open drawer stack below the pill's measured height; drawer starts closed. Verified no overlap at 360×740, 390×844, 430×932 (drawer open and closed), and unchanged layouts at 844×390 (landscape) and 1280×800.

## Before / after

Phone harness, 390×844 @2.75, 4× CPU throttle. "before" = pre-branch FE; "after" = branch FE. Both against the branch worker run locally (so the FE delta is isolated); `settle` = action → last response / long task.

| step | before: req · wire/decoded · settle | before: frames p95 / max | after: req · wire/decoded · settle | after: frames p95 / max |
|---|---|---|---|---|
| load (y=2011-2013) | 1 · 23 KB / 443 KB (l19 rows+labels) · 2.7 s; long tasks 7 / 1047 ms | 84 / 367 ms | 1 · 41 KB / 339 KB (l18 per-year, all years) · 1.5 s; long tasks 5 / 310 ms | 52 / 99 ms |
| pan 300 px | 1 · 24 KB / 451 KB · 5.4 s | **368 / 683 ms** | 1 · 41 KB / 340 KB · 1.1 s | **18 / 34 ms** |
| pan 400 px | 1 · 25 KB / 474 KB · 1.5 s | **683 / 683 ms** | 1 · 43 KB / 353 KB · 0.85 s | 19 / 19 ms |
| zoom in | 3 · 41 KB / 755 KB · 2.2 s | 665 / 665 ms | 1 · 28 KB / 220 KB · 1.0 s | 18 / 19 ms |
| year → 2011-2016 | 1 · 17 KB / 332 KB · 0.64 s | 19 / 132 ms | **0** · 0 · 0 s | — |
| year → 2013-2016 | 1 · 14 KB / 277 KB · 0.67 s | 19 / 19 ms | **0** · 0 · 0 s | — |

- Second "after" run (worker edge cache warm): every `/v1/cells` a cache hit, worker `total` 0-4 ms, request 8-30 ms; pans settle in 0.64-0.87 s, now dominated by the 500 ms fetch debounce.
- Baseline against the *deployed* dev worker (pre-branch FE + worker): load l19 1.46 s request / 3.9 s settle, long tasks 6 / 1340 ms (max 673 ms); pan p95 334-635 ms.
- Default all-years view (no `y`): after = plain `format=cols` l18, 11 KB / 59 KB (D1-servable on prod); first year change fetches the per-year table, then free.

Worker, phone polygon, branch worker (local, remote R2):

| request | R2 GETs | R2 bytes | worker total |
|---|---|---|---|
| l19 2011-13 rows+labels, uncoalesced | 91 | 138 KB | 202 ms (warm footer), 1205 ms (cold) |
| l19 2011-13 rows+labels, coalesced (64 KB gap) | 10 | 166 KB | 100-600 ms |
| l18 2011-13 `format=cols`, coalesced | 6 | 106 KB | 70-150 ms |
| l18 all years `group=year`, coalesced | 6 | 106 KB | 135-185 ms (28k rows → 1044 cells, 83 KB JSON) |
| any of the above, edge-cache hit | 0 | 0 | 0-4 ms |

Deployed dev worker, same phone polygon (curl, pre-branch code): l19 rows+labels 1.3-1.4 s; l18 `format=cols` 0.5 s.

Back-compat runs (branch FE against *old* workers): deployed dev worker (has `format=cols`, no `group_year`) → lean `format=cols` per year range, 5 KB / 22 KB per request, pans smooth (p95 19 ms); deployed prod worker (no `format=cols`) → rows `labels=nums`, 4.5 KB / 63 KB, pans smooth. Year changes refetch on both (no capability), as before.

## Changes

cells-api (`cells-api/src/`):
- `timing.ts`: `Server-Timing` (`manifest`, `cache` hit/miss, `footer`, `r2` + `r2_bytes` + `r2_gets`, `read`, `rows`, `cells`, `coarsen`, `serialize`, `json_bytes`, `total`; `src` d1/pyramid). Workers freeze `Date.now()` between I/O, so CPU-only phases read ~0 in production.
- `index.ts`: edge cache (`caches.default`, key `cellsCacheKey`), `Server-Timing` header (also in `Access-Control-Expose-Headers`), `/v1/manifest` `capabilities: ["format_cols", "group_year", "server_timing", "edge_cache"]`.
- `parquet.ts`: `coalesceRanges` + `coalescingBuffer` around every pyramid read.
- `cells.ts`: `format=cols&group=year` (`CellsColsYearResponse`: distinct sorted cells, `nyears[i]`, flat `year` + count columns), always the pyramid path; coarsens on distinct cells (`maxCells`) and on rows (`max_rows`, default 250k ≈ 3 MB JSON worst case); `polygonTester`; `requestRanges` shared by both query paths.

www (`www/src/map/`):
- `leanCells.ts`: `leanParams` / `decodeLean` (per-year cols, plain cols, legacy rows → one `LeanTable`) / `aggregateLean`.
- `useCellsApi.ts`: `lean` option (own URL, LRU cache, effect; data re-aggregated on filter change), `filter.maxCells`, manifest `capabilities`.
- `picker.ts`: `viewportBinsBudget`, `maxCellsFor`, `HEAT_LEGACY_MIN_CELL_PX`, `heatmapWeightsTextureSize`.
- `CrashMap.tsx`: `HeatmapLayer.weightsTextureSize`.
- `CrashMapSection.tsx`: lean fetch in Heatmap mode, budget / `maxCells` / heat floor wiring, narrow layout via `mapChrome.ts`.
- `www/scripts/mobile-perf.mjs`: the harness.

Tests: `cells-api/src/perf.test.ts` (coalescing, cache key, Server-Timing, `group`/`max_rows` parsing, per-year encode + coarsen), `www/src/map/leanCells.test.ts`, `mapChrome.test.ts`, additions to `picker.test.ts`; all exact-equality.

## Deploy order

All wire changes are **additive and feature-detected**, so either order works:
- old FE ↔ new worker: default request/response shapes unchanged; new headers are ignored.
- new FE ↔ old worker: no `capabilities` on `/v1/manifest` ⇒ no `group=year`; `format=cols` falls back to rows on a worker without it (verified against both deployed workers).

Recommended: **worker first** (`cells-api` `--env dev`, then prod), then the FE — so the FE sees `group_year` from its first load, and prod gains `format=cols` (the deployed prod worker predates it). The edge cache only works on custom domains (`crashes-cells*.hccs.dev`), not `*.workers.dev`.

## Not done / follow-ups

- **Pans still refetch the whole snapped viewport** whenever the pan crosses the snap grid (~¼ viewport); with the edge cache and coalescing that's ~40 KB / 150-500 ms, but a tile-keyed fetch (as heatmap C does) would make pans incremental and far more cache-friendly across users.
- Bins / Points still refetch on year change (they need labels + `fatal_years` for tooltips). They could take the per-year table for counts and fetch labels on hover (`labels=only`).
- The 500 ms fetch debounce now dominates settle time when the edge cache hits; it could shrink (or skip) for URLs likely cached.
- The per-year table's first load is ~8× the wire bytes of a 3-year request (phone: 41 KB vs 5 KB) — the price of free year changes.
- Cold-isolate footer reads (300-600 ms per level file) could be cached across isolates (Cache API / KV).
- Numbers are M4-GPU / CPU-throttled emulation; confirm on a real mid-range Android (the texture cut is 16× in the GPU-bound path regardless).
- Basemap on `*.hccs-ctbk.workers.dev`: add the host in the Stadia dashboard (see 6).

## Round 2: interaction lag (pan / zoom / hover), 2026-09-28

Status: **implemented on branch `map-interaction-perf`, not deployed.** FE-only (no worker change), so no deploy-order constraint.

### Report

On [`dev.crashes.hccs.dev/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013`][dev-view-2], desktop Chrome and an Android phone: panning / zooming "still very slow"; road hover highlights laggy; hovering washed the whole view out with the Jersey City highlight; DevTools showed repeated `road-entities.parquet` reads and a 1.8 s, 137 KB `/v1/cells` request; console `luma.gl: Binding weightsTexture not set: Not found in shader layout.`

### Method

[`www/scripts/interaction-perf.mjs`][iperf]: headful Playwright Chromium on the real GPU (M4, ANGLE/Metal), against unminified `--sourcemap` builds of the base commit and the branch (`vite preview`, `VITE_CELLS_API_BASE=https://crashes-cells-dev.hccs.dev`). Desktop 1440×900 @2, phone 390×844 @2.75 with 4× CPU throttle. Steps: load; a 1 s drag (60 moves at 16 ms) horizontally and vertically; a trackpad-like wheel zoom in and out (20 deltas at 16 ms); a 240-move road-hover sweep across the street grid (desktop); a year change. Per step: rAF frame intervals *during* the interaction, long tasks, React commits (a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__`), heatmap weight-map re-renders (new `?perf=1` counter on `HeatmapLayer._updateWeightmap`), requests by kind, `/v1/cells` Server-Timing, and a CDP CPU profile summarized as inclusive time under named functions + self time per npm package (via the source maps). macOS swap was 0 MB for every reported step.

### Root causes

1. **The heatmap re-aggregated on every rendered frame** (the dominant cost). `CrashMapSection` re-clipped the fetched cells to the viewport in a memo keyed on the per-frame viewport (and on the per-render `result` object), so every pan frame — and every hover, which re-renders the section — gave deck.gl a new `data` array. deck.gl treats that as a data change: all attributes recomputed on the CPU, and the legacy `HeatmapLayer` re-splats its weights texture and re-runs the max-reduction pass (one point per texel: 1M points at 1024²) — i.e. the per-pan GPU cost round 1 tried to bound by texture size was paid on *every frame*, not just when the pan left the texture's bounds. Counted: **62-67 weight-map renders per 1 s pan, 24-33 per wheel zoom, 170 per hover sweep**. On the M4 desktop that pinned pan frames at **p50 60 ms** (points / `hr=b` over the same data: 20 ms), and delayed input so much that the 1 s drag took 5 s to replay; on a phone GPU it's worse. (Phone emulation on the M4 GPU shows smooth frames even before — the 512² texture is cheap there — but the CPU side still shows it: `deck layer updates` 274 ms → 74 ms per pan.)
2. **Hover did a parquet read per road.** `HoverDrawer` → `fetchEntity` read `road-entities` per entity (a ~65 KB, 1000-row group, zstd-decoded each time: `fzstd` + `hyparquet` 100+ ms of a sweep), i.e. the repeated disk-cache hits in the user's DevTools. Each hover also re-rendered the whole section (→ cause 1).
3. **Pans refetched the whole snapped viewport** (one `/v1/cells` for a 1.5-2× bbox; the user's 1.8 s / 137 KB request was a cold edge-cache miss) after a 500 ms debounce.
4. **Area highlight**: the hovered muni is drawn whenever the cursor is inside it; at street zoom that's the whole viewport.
5. `luma.gl: Binding weightsTexture not set` is **benign**: deck.gl 9.3's `HeatmapLayer` sets a `weightsTexture` binding on the weights-pass shader's uniform module, but that pass *renders into* `weightsTexture` (its shader only has a varying of that name), so luma finds no sampler to bind. No extra pass; it logs once. Upstream quirk, not fixable here.

### Fixes

- `stableClip.ts`: the clip is cut to the viewport padded by ½ on each side and **keeps its array identity** until the viewport leaves that window or the data changes. Weight-map renders: 62-170 → **0-3 per interaction**.
- **Tiled lean fetch** (`leanCells.viewportTiles`, `useCellsApi`): Heatmap requests one `/v1/cells` per power-of-two grid tile (side ∈ (span/2, span], ≤ 1°: 1-4 tiles per view), each clipped to the scope polygon. A pan only fetches tiles it newly reaches (the test pans: 0-2 requests, often 0), tile URLs are identical for every user (edge-cache friendly), tiles are cached per URL (LRU 256) with a per-table aggregation memo (`aggregateLeanTables`), and the swap to a new tile set is atomic (stale tiles render meanwhile). The fetch fires once the view has held still 250 ms (was: 500 ms after each URL change, so a wheel zoom's intermediate levels each fired a round). Cold tiles: 0.3-1.5 s each, in parallel (cold union bbox: 1.7 s); warm: 25-60 ms.
- **Road hover**: `road-entities` rows are cached per row group (`readRows(..., { wholeGroups: true })`, `peekEntity`), and the groups for the roads in view are prefetched (`prefetchEntities`, ≤ 4 groups). Hover summaries then render synchronously (no 150 ms wait, no read): road-entities requests per sweep **25-30 → 0**. `sameRoad` keeps the previous hovered point while the cursor stays on one road, so moving along it doesn't re-render.
- **Area highlight rule** (`boundaries.areaHighlightShown`): the hovered muni / county is not drawn when its bbox covers ≥ 85% of the viewport *and* is ≥ 1.5× the viewport's area — i.e. zoomed in inside it. An area that fits the view or only partly overlaps it still highlights; the hover drawer still names it. Jersey City at z14.5: hidden on desktop and phone; at z12.5, and Hoboken at z14.5: shown.

### Before / after

`before` = base `df3f79791ab`, `after` = this branch; same dev worker. Frames = rAF interval during the interaction (20 ms ≈ idle vsync here), `wm` = heatmap weight-map renders.

| step | before: frames p50/p95/max · wm · replay time | after: frames p50/p95/max · wm · replay time |
|---|---|---|
| desktop pan-x (1 s drag) | **60/100/181** · 62 · 5.1 s | **20/21/21** · 1 · 2.4 s |
| desktop pan-y | 61/100/140 · 63 · 5.0 s | 20/21/21 · 0 · 2.4 s |
| desktop zoom-in (wheel) | 21/81/100 · 33 · 2.4 s | 20/21/21 · 1 · 0.8 s |
| desktop zoom-out | 21/81/101 · 28 · 2.1 s | 20/21/60 · 3 · 0.9 s |
| desktop hover sweep | **39/120/161** · 170 · 14.3 s · 30 road-entities reads | **20/21/21** · 0 · 4.9 s · 0 reads |
| phone pan-x (4× CPU) | 20/21/60 · 67 · CPU busy 2.0 s | 20/21/40 · 3 · CPU busy 1.6 s |
| phone pan-y | 20/21/21 · 63 · busy 1.5 s | 20/21/21 · 3 · busy 1.3 s |
| phone zoom-in | 20/21/21 · 24 · settle 1.4 s | 20/21/21 · 1 · settle 1.1 s |
| year change (both) | 0 requests | 0 requests |

CPU attribution, desktop 1 s pan (inclusive ms): deck frame 124 → 69, deck layer updates 86 → 29, heatmap weight-map 16 → 1; maplibre render ~180-200 both (now the largest main-thread item). Hover sweep: deck frame 314 → 150, layer updates 192 → 45, parquet reads 35 → 0, `nearestRoad` 23-33 (≈0.1 ms per move). Phone pan: deck frame 418 → 212, layer updates 274 → 74, weight-map 65 → 4. No long tasks during any interaction, before or after.

### What's left

- Real-device GPU numbers: the M4 hides GPU cost (SwiftShader at DPR 2 was too slow overall to separate layers). The remaining per-frame GPU work is maplibre's raster basemap (`@2x` tiles) + deck's draw; the heatmap now re-aggregates only when a pan leaves the texture's bounds (texture covers 2× its size in CSS px: phone 512² → 1024 px, so ~90 px of vertical slack on a 844 px-tall phone — a larger texture trades rarer re-aggregations for costlier ones).
- Each hover still re-renders `CrashMapSection` (~0.3 ms/move on desktop); hover state could move into a small store so only the drawer and road layers re-render.
- `maplibre` is now the top main-thread cost during pans (~180 ms/s desktop, ~500 ms/s phone @4×).
- Bins / Points still use the single snapped-bbox row fetch (they need labels); they'd benefit from the same tiling.
- Cold tile latency is dominated by the worker's per-isolate footer read (200-480 ms) and R2 GETs; the edge cache makes repeats 25-60 ms.

### Regression: Heatmap drew nothing (branch `heat-fix`)

Round 2 was merged into `map-mode-heatmap-on-cells` (`e491b962012`) and deployed to dev; the legacy Heatmap then drew **nothing** on [the dev view][dev-view-2] (all years and `y=2011-2013`), while Points / Bins, the basemap, road hover and the area-highlight rule worked, the tile requests 200'd, and there was no console error. Dev www was rolled back.

**Not minification**: a `--minify false` build of `e491b962012` is blank too, and so is the minified one; the base `df3f79791ab` paints in both. It was blank on the branch all along at desktop sizes — the Round 2 numbers above counted weight-map renders, not pixels. (Phone-sized views often painted by luck: see below.)

**Root cause**: the *first* weight-splat pass a deck.gl `HeatmapLayer` runs after it initializes is wrong (deck.gl 9.3.2 / luma.gl 9.3.3). Instrumenting `_updateWeightmap` (reading back `maxWeightsTexture`) at the dev view, 1280×800, same data and bounds:

| pass | max-weight texel (R … A) |
|---|---|
| 1st pass after init | 12707 … 63.5 |
| any later pass | 5102 … 3.9 |

The first pass piles the splats into a few texels (alpha ≈ number of overlapping points: 63 vs 4), so the whole surface normalizes under the color `threshold` and nothing draws. Re-running only the max-reduction doesn't fix it; re-running the splat does — any second pass is correct. Before Round 2 this was masked: the heatmap got a new `data` array on nearly every render (the per-render clip, root cause 1 above), and each one re-splatted. `stableClip` keeps the data's identity, so a layer's *only* pass was the broken first one, until the next data or bounds change (a year change or a pan past the texture's bounds would repaint it; a view that happened to get two data updates while loading — e.g. tiles arriving separately, common on phones — painted).

**Fix**: `www/src/map/PrimedHeatmapLayer.ts` — a `HeatmapLayer` subclass that runs its first weight-map update twice (flag in the layer `state`, which deck.gl carries across re-created layer instances); `CrashMap` uses it for the legacy heatmap. Cost: one extra splat when the layer is created. `?perf=1` counts after the fix (desktop, SwiftShader): load 2 weight maps (the priming pass), 150 px pans 0, a 300 px pan 1, a 20-move hover 0 — the Round 2 wins hold.

**Guards**: `www/e2e/heatmap-paints.spec.ts` (warm-pixel fraction of the page; blank 0.0003, painted ≈ 0.025, threshold 0.005): Heatmap all years / `2011-2013` × desktop / phone, Points as a control, and Points → Heatmap mode switch. On `e491b962012` the desktop Heatmap cases fail (0.0003); with the fix all pass. `PrimedHeatmapLayer.test.ts` pins the pass counts (2, then 1 per update).

Verified on a minified `vite build` + `vite preview` against `crashes-cells-dev.hccs.dev`: Heatmap all years / 2011-2013, Bins, Points on desktop 1280×800 and phone 390×844 all paint; load 2 tile requests; all years → 2011-2025 2 requests (switch to the `group=year` tiles), then → 2011-2013 0; 100 / 500 px pans 0 (tiles already cover them).

## Round 3: heatmap quality, default render, selectable-road overlay (2026-09-28)

Status: **implemented on branch `heat-default-roads`, not deployed.** FE-only (no worker change).

### Report

At [`/map?llz=40.7184-74.0736+13.25+0+0&mode=heatmap&y=2011-2013`][dev-view-3] (desktop, default `hr=legacy`) the heatmap was a lattice of discrete round blobs at S2 cell centers ("griddy"). Of the other renders: `hr=b` dim and blocky; `hr=a` smooth but with a grey rectangle over the basemap; `hr=c` best-looking (follows streets). Separately: draw the roads that are available for hover / pin.

### Method

Builds of the base (`dca29a31663`) and the branch (`vite build`, `VITE_CELLS_API_BASE=https://crashes-cells-dev.hccs.dev`) served with `vite preview`. Screenshots: headless Chromium on the M4 GPU, desktop 1440×900 @2 and phone 390×844 @2, dark theme, z12 / z13.25 / z14.5 at the view above (`www/tmp/shots.mjs`-style harness; images under the worktree's `tmp/shots/`). For the knob A/B, a throwaway build read `?abfloor=` / `?abwts=` / `?abclip=` overrides (not committed). Perf: [`interaction-perf.mjs`][iperf] headless (`HEADLESS=1`), desktop 1× and phone 4× CPU, on the Round 2 view (z14.5, `y=2011-2013`). System swap was 4.7-5.0 GB *resident* (other apps) but flat through every run (±30 MB, recorded per step), i.e. not actively swapping; free disk ≥ 37 GB throughout.

### Griddiness: the legacy cell floor (Round 1), not the texture or the clip

deck's `HeatmapLayer` kernel is a Gaussian with σ = `radiusPixels / 6` = **5 CSS px** (`weights-fs`: `exp(-u²/0.0556)` over the 30 px radius). The layer splats one kernel per *cell center*, so wherever cells are much wider than σ each cell shows as its own blob, and the blobs sit on the S2 grid.

Round 1's `HEAT_LEGACY_MIN_CELL_PX = 5` floored the legacy fetch at 5 px cells — but the picker takes the finest level whose cell is ≥ the target, so a 5 px floor gives **5-10 px** cells. On a 1440×900 desktop the budgeted target is ~3 px, so the floor coarsened z12 and z13.25 by a level each:

| desktop 1440×900 | budgeted pick | floor 5 px (HEAD) | floor 3 px (fix) |
|---|---|---|---|
| z12 | l16 (~5 px) | **l15** (~10 px) | l16 |
| z13.25 | l17 (~5 px) | **l16** (~10 px) | l17 |
| z14.5 | l18 | l18 | l18 |
| phone 390×844, z13.25 | l18 | l16 | l17 |
| phone 390×844, z14.5 | l19 | l18 | l18 (Round 1's win kept) |

Knob A/B (each reverted alone, same views; mean absolute luma difference vs HEAD over the screenshot):

| knob | z12 | z13.25 | z14.5 | visual |
|---|---|---|---|---|
| floor 5 → 0 | 12.0 | 14.7 | 0 | lattice gone at z12-13.25 |
| `weightsTextureSize` auto → 2048 | 0.02 | 5.4 | 0 | same lattice (the texel is always 2 CSS px: deck sizes the texture's world bounds as `textureSize × 2 / scale` around the *viewport*, so a smaller texture only means less pan slack) |
| `stableClip` off | 0 | 0 | 0 | identical (the clip only drops off-screen cells; the texture's bounds don't depend on the data) |

**Fix:** `HEAT_LEGACY_MIN_CELL_PX = 3` — cells stay ≤ ~6 px (≈ σ) at every desktop zoom, phone z14.5 stays at l18. Pinned in `picker.test.ts` (desktop z12 / z13.25 / z14.5 picks unchanged by the floor; phone z14.5 still l18). Pan / zoom / year cost unchanged (table below). Residual "blobbiness" at street zoom (z14.5+) is inherent: 3 years of crashes on a residential grid are sparse points, each drawn as a 5 px-σ kernel.

No lattice check in `e2e/heatmap-paints.spec.ts`: two pixel metrics on these screenshots — fraction of warm 5×5 blocks with no warm neighbor, and local-maxima density per warm pixel — gave 0.002 vs 0.001 and 16 vs 12 per 1k (HEAD vs fixed, z13.25), and z14.5 (sparse data, no lattice) scored as high as the lattice. Too weak to guard with; the unit test pins the cause instead.

### `hr=a` grey rectangle: dropped

A baked *one* image over the fetched (clipped) cell set, self-normalized, and drew it as a single `BitmapLayer` quad. Two properties make the rectangle:
- the image's extent is the data's extent (clip window + 3σ), so wherever the fetched set ends — the `stableClip` window's edge after a pan, a tile not yet loaded, or the old window during a zoom-out — the surface stops at a hard straight edge (reproduced: a 300 px pan shows a vertical cut through Newport; a wheel zoom-out shows the old window as a small rectangle);
- its σ = 0.9 × cell edge kernel tails cover most of that extent at low density, where the colormap is inferno's near-black at 10-30% alpha: a dark / grey veil over the basemap across the whole populated rectangle (most visible in light theme).

Plus the bake mapped latitude linearly into a quad that deck draws linearly in Web-Mercator (a small N-S misregistration). C is A done right (per-tile bakes at screen resolution, shared normalization, margins for kernel bleed), so A was removed rather than patched: `?hr=a` now falls back to the default. `bakeDensity.ts` keeps only the splat / colorize passes C uses.

### Default: C

Visual (montages `tmp/shots/cmp-{desktop,phone}-z{12,13.25,14.5}.jpg`): C follows streets at every zoom with the finest detail (S2 l19-l20 cells at 1 px, σ 1 px); legacy (3 px floor) is smooth but coarse, glowing blobs; B is dim / blocky.

C before this round was not a viable default on cost: 15-22 `/v1/cells` requests per load (one per z15 tile), a full refetch of every tile on each year change (the tile cache was keyed by the year range), a re-bake of every visible tile on every pan settle (7 long tasks / 537 ms on a desktop pan), no scope-polygon clip (county / muni maps would show neighbors' crashes), and the section's own lean fetch still ran underneath it. Changes (`useHeatTiles.ts`):
- **Fetch unit = the parent tile** (`tileZ − 1`, padded 15%, which covers each child's 30% bleed margin): ¼ the requests, and cacheable across users.
- **Lean wire format + `group_year`** (`leanParams` / `fetchLean` / `aggregateLeanTables`, shared with legacy): a year sub-range fetches the per-(cell, year) table over all years and severities once, and year / severity changes re-aggregate locally — **0 requests**.
- **Bake caches**: density grids memoized per (tile, table, filter, σ, size) — σ computed at the tile's own latitude and the bake size rounded to a half power of two, so pans / small zooms keep keys — and colorized images per (grid, `vmax`); `vmax` is sticky within ±25% (`stickyVmax`), so a pan colorizes only the tiles it newly reached.
- **Scope clip**: each tile's polygon is `clipPolygonToBbox(scope, padded tile)`; tiles outside the scope aren't requested.
- `CrashMapSection` skips its cells fetch in C mode (C doesn't render it) and doesn't gate the map on it.

Perf (`before` = HEAD `dca29a31663`, `after` = branch; frames = rAF p50 / p95 / max during the interaction, ms; `req` = `/v1/cells` requests; `lt` = long tasks count / total ms):

| step | legacy before | legacy after | C before | C after |
|---|---|---|---|---|
| desktop load | 2 req · lt 2/155 · settle 1.7 s | 2 req · lt 2/295 · 1.6 s | **22 req** · lt 0 · 1.3 s (warm edge cache) | **9 req** · lt 0 · 1.5 s |
| desktop pan-x (1 s drag) | 17/18/34 · 0 req | 17/18/34 · 0 req | 17/18/18 · 8 req | 17/18/18 · 3 req |
| desktop pan-y | 17/18/18 · 0 req | 17/18/18 · 0 req | 17/18/67 · **lt 7/537** · bake 516 ms | 17/18/18 · lt 0 · bake 35 ms |
| desktop zoom-in (wheel) | 4 req | 4 req | 19 req | 6 req |
| desktop zoom-out | 0 req | 0 req | 0 req | 0 req |
| desktop hover sweep | 17/18/18 | 17/18/18 | 17/18/18 | 17/18/18 |
| desktop year change | 0 req · 14 ms | 0 req · 16 ms | **15 req** · 290 ms | **0 req** · 249 ms (one 59 ms re-bake) |
| phone load (4× CPU) | 2 req · lt 5/399 | 2 req · lt 5/440 | 10 req · lt 6/394 | 3 req · lt 5/402 |
| phone pan-x | 17/18/50 · 2 req | 17/18/51 · 2 req | 17/18/51 · 6 req | 17/18/49 · 3 req |
| phone pan-y | 17/18/18 | 17/18/18 | 17/34/117 · **lt 7/746** | 17/18/18 · lt 0 |
| phone zoom-in | 6 req | 6 req | 6 req | 0 req · lt 1/80 |
| phone year change | 0 req · 45 ms | 0 req · 47 ms | 6 req · 368 ms | **0 req** · 345 ms (one 141 ms re-bake at 4×) |

Swap during these runs: 4696-4720 MB, flat. C after is at parity with legacy on frames and requests (fewer on zoom), and its year change costs one re-bake of the visible tiles (59 ms desktop, 141 ms phone at 4× CPU) instead of a GPU re-splat. Cold tiles are the worker's cost (a cold l18-l20 `group=year` read measured 1-4.5 s of R2 time on the dev worker; edge-cache hits 11-160 ms).

`?hr=` default is now `c` (omitted from the URL); `legacy` and `b` stay selectable (drawer order C / Legacy / B; omnibar actions).

### Selectable-road overlay

When road selection is active (z ≥ 9, the `HIT_TIERS` range), the hit-test points already loaded for hover / tap (`sri-hit-5` major roads from z9, `sri-hit-6` from z11, `sri-hit` from z13) are drawn as a thin (1.5 px) non-pickable `PathLayer` **under** the data layers (`CrashMap` `underLayers`), theme-aware (dark: pale blue α 70; light: navy α 60), fading in from 35% opacity at z9 to full at z13. No extra fetches (reuses `hitPoints`; paths rebuild only when those change, zoom only moves the layer opacity). Toggle "Show selectable roads" in the settings drawer, default on, persisted as `?rd=off` (absent = on, like other map params). Screenshots: `tmp/shots/roads-{dark,light}/{desktop,phone}-z{13,14.5,16}-{on,off}.jpg`, crops `tmp/shots/roads-{dark,light}-crops.jpg`.

Cost (desktop, C, same steps, `rd` on vs off): pan-x frames 17/18/34 vs 17/18/34, deck draw 159 vs 149 ms per 1 s pan, hover sweep deck draw 180 vs 183 ms — within run-to-run noise.

### Tests

- `picker.test.ts`: the floor keeps desktop z12 / z13.25 / z14.5 at the budgeted level.
- `useHeatTiles.test.ts`: `parentTile`, `fetchTiles`, `stickyVmax`, `tileUrl` (per-year vs filtered params, scope clip that misses → no request), all exact-equality.
- `e2e/heatmap-paints.spec.ts`: default (C) and legacy × desktop / phone × all years / 2011-2013, Points control, Points → Heatmap switch.

### Not done / follow-ups

- **Cold worker reads** dominate first paint for C's fine levels (l19-l20 `group=year` parent tiles: 1-4.5 s R2 time cold). Pre-warming the edge cache for common views, or a coarser-level `group=year` first paint, would help.
- C's bakes run on the main thread (one 59-141 ms task per year change / new tile set); a worker (`OffscreenCanvas` / transferable `ImageData`) would take them off.
- In light theme at z12-13, C's floor-lifted purple reads heavier than on dark; the colormap floor / alpha knee could be theme-specific.
- Separately observed while benchmarking: the dev worker's `/v1/manifest` occasionally took 5-30 s cold, leaving the map on "Loading map…" until it returned.

[dev-view-3]: https://dev.crashes.hccs.dev/map?llz=40.7184-74.0736+13.25+0+0&mode=heatmap&y=2011-2013

[dev-view-2]: https://dev.crashes.hccs.dev/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013
[iperf]: ../www/scripts/interaction-perf.mjs

[dev-view]: https://crashes-www-dev.hccs-ctbk.workers.dev/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013
[perf-script]: ../www/scripts/mobile-perf.mjs
