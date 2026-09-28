# Map mobile performance (heatmap / points / bins) + narrow-layout overlap

Status: **implemented on branch `map-mobile-perf`, not deployed** (2026-09-28).

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

[dev-view]: https://crashes-www-dev.hccs-ctbk.workers.dev/map?llz=40.7213-74.0810+14.5+0+0&mode=heatmap&y=2011-2013
[perf-script]: ../www/scripts/mobile-perf.mjs
