# Map heatmap/density render strategies — A/B/C + benchmark

Status: **design (2026-09-14)**. Focused follow-on to [`map-viewport-stats-and-rendering.md`](./map-viewport-stats-and-rendering.md) Part B (which this supersedes for the *rendering* question). Goal: replace the unusably-slow deck.gl `HeatmapLayer` with a SOTA, smooth-at-any-zoom density render, and build **three strategies (A/B/C) side by side so we can compare + benchmark** them before committing to one.

## Problem (confirmed)

deck.gl's `HeatmapLayer` re-runs its **KDE** (Kernel Density Estimation — each point contributes a Gaussian kernel over a screen-pixel radius; overlapping kernels sum into a density surface) **on every viewport change**. Because `radiusPixels` is screen-space, *zoom* changes every kernel's world footprint → full GPU re-aggregation per frame. At statewide zoom we feed it ~15k cell points and it re-blurs them each frame → unusable pan/zoom on a phone (and sluggish on desktop).

`debounceTimeout` is a no-op band-aid (500 is the deck.gl default already); the problem is architectural, not a layer prop.

**We are not data-bound in the way it first looked, but we were over-fetching:** the client requested up to `maxCells=150000` over the whole-state polygon *and* prefetched res±1 levels (res14 ≈ 421 kB) that a statewide view never renders. The prefetch is now gated to Bins mode and deferred until after the primary render (commit `57c0937a87d`).

## The principle to steal (CarbonPlan `zarr-layer` / CARTO tile layers)

Local OSS clones for reference: `~/c/carbonplan/{zarr-layer,maps,ndpyramid,topozarr,benchmark-maps}`.

> **Decouple per-frame GPU redraw from per-data-load work.** Hold data as GPU textures/geometry; a *frame* is just a redraw of resident buffers; only a **level change or filter change** touches the network or re-aggregates. Compute **color on the GPU** from a 1-D colormap texture, so changing ramp / clim (thresholds) / opacity costs **zero** refetch or re-aggregation.

We have already done the expensive half: **cells-api is our pre-aggregated multiscale pyramid** (S2 levels l4–l21). We do *not* need zarr on the wire — our sharded parquet/JSON *is* the pyramid. What we need is to stop rendering with a per-frame-aggregating layer.

deck.gl layer taxonomy (the deciding fact):
- **Re-aggregate in screen space, every frame:** `HeatmapLayer`, `ScreenGridLayer`, `ContourLayer`. ← the trap.
- **Pure per-frame GPU redraw (aggregation only on data load):** `ScatterplotLayer`, `ColumnLayer` (our Points/Bins — already smooth), `BitmapLayer`, `SolidPolygonLayer`.

## The three strategies

All three consume the **same** aggregated `StackedCell[]` from cells-api and expose the same severity-weighted density. They will be selectable (URL param, see "Harness") so we can A/B/C them live and benchmark.

### B — direct cell geometry (baseline; ~1 day) — ✅ BUILT (`?hr=b`)
Render cells as GPU geometry with no per-frame aggregation. As shipped:
- **`SoftDiscLayer`** (`www/src/map/SoftDiscLayer.ts`) — a `ScatterplotLayer` subclass that injects a **radial Gaussian alpha falloff** (`color.a *= exp(-3·d²)` in `fs:DECKGL_FILTER_COLOR`), so each cell is a soft density *kernel* that blends with its neighbors into a continuous field rather than a flat "bokeh" disc. The disc is drawn at `1.3×` the S2 cell edge (world meters) so kernels overlap.
- Color from a **sequential colormap** (`www/src/map/colormap.ts`, inferno) sampled at `t = (w/wmax)^0.5` (γ=0.5 tames the heavy tail); severity carried by the `HEAT_W_*` weighting of `w`. Per-cell **alpha ramps to 0 below `t≈0.3`** so sparse low-count cells fade out (like a KDE surface's edges) instead of showing as dark discs. Colors are computed **CPU-side, once per data-load** in the layer-build memo — not per frame — so pan/zoom is a pure GPU redraw.
- **Smooth:** ✅ (same layer family as Points; verified instant pan/zoom + level-change at statewide and city zoom, no per-frame re-aggregation). **Look:** continuous soft KDE-like surface; faint S2 texture only in mid-density areas at some zooms. **Verdict:** strong — may be *enough*; de-risks A.
- Colormap is CPU-sampled for B (fine, since it's per-data-load only); A/C upload the same `colormap.ts` stops as a **GPU 1-D texture** so clim/ramp/opacity become free uniforms.

### A — bake density to an image, pan a `BitmapLayer` (recommended headline) — ✅ BUILT (`?hr=a`)
The CarbonPlan playbook minus zarr — implemented with a **CPU splat** rather than a GPU render-to-texture pass (`www/src/map/bakeDensity.ts`):
- On each **data-load event** (cell set changes — level/filter/geo), splat each cell's severity-weighted count as a **Gaussian kernel** into an accumulation grid over the cells' world bounds (σ = `0.9×` the S2 cell edge, padded 3σ), normalize, and map through the shared `colormap.ts` ramp → an `ImageData`. Memoized on `[cells, dataRes]`, so it runs **once per data-load**, never on pan/zoom/opacity.
- Hand that image to a stock **`BitmapLayer`** with the bake's lng/lat `bounds`. Pan/zoom = free textured-quad redraw.
- **Smooth:** ✅ (BitmapLayer redraw only; verified statewide + city). **Look:** silky continuous KDE — smoother than B (no cell grid) while keeping corridor/intersection structure; the best-looking of the three. **Bake cost:** tens of ms per data-load (TTFR sits between B and legacy). **Resolution:** the image is fixed-res (`maxDim=1024`), but bounds shrink with the viewport's data so deep zoom stays crisp; extreme over-zoom past the bake density would soften.
- **Why CPU not GPU-framebuffer:** doing render-to-texture *inside* deck.gl (vs CarbonPlan's standalone MapLibre CustomLayer) needs an awkward multi-pass; the CPU splat is fully in-hand, fast enough at these cell counts, and renders identically. **Deferred refinement:** move the colormap to a GPU 1-D texture via a `BitmapLayer` subclass (reusing `colormap.ts` stops), making clim/ramp/opacity free uniforms — worthwhile only if we expose those controls.

### C — multiscale `TileLayer` over cells-api (scalable end-state; ~3–5 wk)
`@deck.gl/geo-layers` `TileLayer` whose `getTileData` fetches the S2 shards for a tile at the **screen-matched S2 level** (our l4–l21 maps onto tile z), and whose `renderSubLayers` emits either per-tile geometry (B-per-tile) or a per-tile baked density `BitmapLayer` (A-per-tile). Inherits deck.gl's LRU tile cache + coarse-under-fine fallback for free.
- Requires cells-api work: a tile-addressed endpoint (`/{z}/{x}/{y}` or S2-token-addressed) with **filter state in the tile key** so TileLayer caches on `(tile, filterState)`.
- **Smooth:** ✅, and the only option that scales to statewide-at-l21 without ever fetching tens of thousands of rows at once. **Risk:** high; most work. This is the most SOTA/best-practice answer.

Rejected — **D: adopt `zarr-layer` literally.** Would force converting sparse S2 aggregates into a Mercator/lat-lon zarr array per filter-state (throwing away S2's variable resolution, reintroducing pyramid-build cost) and running a second renderer outside deck.gl. Reference only.

## Harness (how we compare + benchmark) — ✅ BUILT

- **Toggle:** a golfed enum URL param `?hr=` (**h**eat-**r**ender strategy), values `a` | `b` | `c`, with the existing deck-native `HeatmapLayer` as the **default** (param omitted) so it's the zero-config baseline. Selectable from the Heatmap-mode controls (A/C disabled until built). Orthogonal to `mode`.
- **Harness:** `www/e2e/heatmap-render-bench.spec.ts` (`pnpm test:bench` / `test:bench:viz`), matrix = 3 viewports (statewide/county/city) × 2 widths (desktop/mobile) × `HR_STRATEGIES` (default `legacy,b`; add `a`/`c` as they land).
- **What it measures — and what it can't:**
  - **Bytes fetched** + **cell count / S2 level** (from network + the `perf=1` `__crashMapDebug` hook) — reliable headless. Confirms B/A change only *how* cells draw, never *what* is fetched (legacy≡B bytes at every combo).
  - **Time-to-first-render** (nav → first cells painted) — reliable headless; already shows B first-rendering ~1.5–2.5× faster than legacy (legacy builds its GPU aggregation textures + heatmap program on first paint).
  - **Screenshot matrix** (`test:bench:viz`, `BENCH_SHOTS=1 --headed`) → `test-results/heatmap-bench/<vp>-<w>-<hr>.png`. Must be **headed**: headless Chromium's software-GL backend captures the WebGL canvas as blank. This is the repeatable multi-vp look artifact (satisfies the "algo/render change needs multi-vp eval" rule).
  - **No automated FPS.** Interaction smoothness is the point of B/A, but it's **GPU-bound** (legacy's per-frame KDE re-aggregation runs on the GPU) and headless is software-GL — a headless frame-rate would neither reproduce the mobile pain nor distinguish strategies. Synthetic Playwright drag also doesn't drive deck's controller reliably. **Smoothness is judged on the screenshots (look) + a device/CIC pan (feel)** — desktop CIC already confirms B pans with instant redraw where legacy stalls.
- CarbonPlan's `~/c/carbonplan/benchmark-maps` was the reference for the Playwright approach; the FPS-under-load metric there assumes a real GPU, which is why ours is device/CIC, not headless.

## Sequencing

1. ✅ Cleanup: gate + defer prefetch (`57c0937a87d`); mode buttons live + Points/Heatmap cell-fed (`7d230f1e526`).
2. ✅ **B** — soft-kernel baseline (`SoftDiscLayer` + `colormap.ts`, `?hr=b`). Smooth; strong look; may be enough.
3. ✅ **Benchmark harness** (`heatmap-render-bench.spec.ts`, `test:bench` / `test:bench:viz`) — bytes/ttfr/cells numbers + headed screenshot matrix. Compares legacy / B / A via `HR_STRATEGIES`.
4. ✅ **A** — baked-KDE continuous surface (`bakeDensity.ts` + `BitmapLayer`, `?hr=a`). Benchmarked legacy/B/A across the matrix.
5. **Decide** B vs A as the shipped default (both smooth; A prettier, B lighter/no bake) → scrns/device eval → flip default + retire legacy.
6. **C** only if statewide-at-fine-zoom or large filter cross-products justify the cells-api tile endpoint.

## Decisions (were open questions; resolved to reasonable defaults 2026-09-14)

- **Colormap:** start with a dedicated sequential density ramp (viridis/inferno-style) for the surface strategies — a single-hue-family ramp reads as "density" better than the categorical F/I/O palette, and severity is already carried by the `HEAT_W_*` weighting of the input. The GPU colormap makes this a free later toggle, so B/A will accept a ramp uniform and we can offer a severity-tinted variant if it's wanted after seeing it live.
- **KDE weighting (A):** reuse the existing `HEAT_W_FATAL/INJURY/PDO` weights, exposed as shader uniforms so they're tunable without a re-bake path change.
- **C tile addressing:** deferred with C itself — lean toward S2-token addressing (matches the existing pyramid natively, avoids a z/x/y↔S2 remap) with filter state folded into the tile cache key; revisit when C is scheduled.
