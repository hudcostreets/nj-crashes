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

### B — direct cell geometry (baseline; ~1 day)
Render cells as GPU geometry with no per-frame aggregation:
- `ScatterplotLayer` of soft-alpha discs (additive blend), radius ∝ √count, **or** `SolidPolygonLayer` of the actual S2-cell quads, colored by GPU-normalized density.
- Color via a custom fragment shader reading raw density + a 1-D colormap texture (so clim/ramp are live uniforms).
- **Smooth:** ✅ (redraw only). **Look:** "celled"/soft-blob; S2 grid faintly visible at low zoom. **Risk:** low; reuses existing StackedCellLayer/Scatterplot machinery. De-risks A.

### A — bake density to a texture, pan a `BitmapLayer` (recommended headline; ~1–2 wk)
The CarbonPlan playbook minus zarr:
- On each **data-load event** (viewport level change or filter change), splat the fetched cells' severity-weighted counts into an **offscreen framebuffer** (luma.gl `Framebuffer`) covering the current region — a real Gaussian KDE done **once**, not per frame.
- Hand that texture to a **custom `BitmapLayer` subclass** with `bounds`; its fragment shader reads raw density and applies the 1-D colormap (copy `zarr-layer/src/colormap.ts` + the `shaders.ts` rescale-and-sample snippet).
- Pan/zoom = free textured-quad redraw. **Ramp / clim / opacity changes = uniform-only, no re-splat.** Only filters/geo/level re-splat.
- **Smooth:** ✅. **Look:** silky continuous KDE. **Risk:** medium (render-to-texture pass + custom layer shader). We're in Web Mercator already, so no mesh reprojection needed.

### C — multiscale `TileLayer` over cells-api (scalable end-state; ~3–5 wk)
`@deck.gl/geo-layers` `TileLayer` whose `getTileData` fetches the S2 shards for a tile at the **screen-matched S2 level** (our l4–l21 maps onto tile z), and whose `renderSubLayers` emits either per-tile geometry (B-per-tile) or a per-tile baked density `BitmapLayer` (A-per-tile). Inherits deck.gl's LRU tile cache + coarse-under-fine fallback for free.
- Requires cells-api work: a tile-addressed endpoint (`/{z}/{x}/{y}` or S2-token-addressed) with **filter state in the tile key** so TileLayer caches on `(tile, filterState)`.
- **Smooth:** ✅, and the only option that scales to statewide-at-l21 without ever fetching tens of thousands of rows at once. **Risk:** high; most work. This is the most SOTA/best-practice answer.

Rejected — **D: adopt `zarr-layer` literally.** Would force converting sparse S2 aggregates into a Mercator/lat-lon zarr array per filter-state (throwing away S2's variable resolution, reintroducing pyramid-build cost) and running a second renderer outside deck.gl. Reference only.

## Harness (how we compare + benchmark)

- **Toggle:** an enum URL param (e.g. `?render=heat-b|heat-a|heat-c`, plus the existing deck-native `HeatmapLayer` as `heat-legacy` for a baseline) selectable from the debug drawer. Follows the earlier `?render=` prototype pattern.
- **Metrics** (borrowing from `~/c/carbonplan/benchmark-maps`, a Playwright harness):
  - **Interaction FPS / long-frame count** during a scripted pan + zoom sequence (the headline number).
  - **Bytes fetched** per viewport-level and per filter change.
  - **Time-to-first-render** (cold) and **time-to-render after a level change**.
  - **Aggregation/bake time** per data-load (A/C) — logged via the existing `perf` hook (`__crashMapDebug`).
- Multi-viewport eval (statewide, county, city) × desktop + mobile widths via the scrns matrix — per the "algo/render changes need multi-vp eval" rule; do not judge on a single CIC.

## Sequencing

1. ✅ Cleanup: gate + defer prefetch (`57c0937a87d`); mode buttons live + Points/Heatmap cell-fed (`7d230f1e526`).
2. **B** first — same-day baseline, may be enough, de-risks A.
3. **A** — the headline continuous surface.
4. Benchmark harness + scrns matrix; compare B/A/(legacy).
5. **C** if statewide-at-fine-zoom or large filter cross-products justify the cells-api tile endpoint.

## Open questions

- Colormap: reuse the Fatal/Injury/Other severity palette as a diverging/sequential ramp, or a dedicated density ramp? (GPU colormap makes this a free toggle.)
- KDE weighting for A: same `HEAT_W_*` severity weights, exposed as uniforms.
- For C: tile addressing scheme (`z/x/y` vs S2 token) + how filter state keys the tile cache.
