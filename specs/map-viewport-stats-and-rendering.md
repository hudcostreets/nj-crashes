# Map viewport stats, mixed-level covers, and grid-agnostic rendering

Status: **design + benchmarked (2026-09-14)**. Companion to the map load-speed plan (Phase 1 shipped; Phase 2 = mixed-level cover) and to pyrmts's [`pyrmts-column-cube.md`](https://github.com/runsascoded/pyrmts) (the shared column-cube primitive). This doc captures two co-arising threads:

- **Part A — viewport summary stats** (X crashes / F·I·O, deaths, serious injuries, totaled vehicles, hit-and-runs, …) for the current view, and the "cube" question behind them (materialize categorical axes as columns). Includes the footer-cost benchmark that de-risks it.
- **Part B — how to render a mixed-level S2 cover** without leaking the bin grid, plus a survey of scalable-geo-rendering options.

Cross-session note: pyrmts and crashes co-designed the cube. **Neither is blocked on the other.** pyrmts's `pyrmts-column-cube.md` is *proposed — tabled*; crashes does the near-term measures **locally** (no pyrmts dependency). pyrmts's shared machinery (fleet-manifest + planner + monoid rollup columns) is only needed at the *hundreds-of-columns* scale, which the benchmark below shows is far off. pyrmts's own `/read crashes` already reached this conclusion.

## Context — the data model today

- The map is fed by the `crashes-cells-api` CFW, which serves **per-S2-cell aggregates** — crash-severity counts only: `n_fatal`, `n_inj_ped`, `n_inj_other`, `n_pdo`, `n_vehs`. Two paths: a D1 fast path (`cells-s2.db`, all-years default) and a parquet pyramid (`data/cells/s2_pyramid`, filtered queries) with per-level tables l4–l21.
- The parquet pyramid already computes a **richer** set (`n_crashes`, `n_killed`, `n_killed_ped`, `n_injured`, `n_inj`, …); the D1 rollup keeps only the 5-column subset above.
- The rollup has **no victim-type dimension** (driver/passenger/cyclist) — only pedestrians are separable (`n_inj_ped`/`n_killed_ped`). This is why the page-level victim-type filter (`?t=…`) is silently ignored on the map.
- Aggregation source: `njdot/cli/cells.py`. Note crashes **already** pivots categorical axes into columns elsewhere — `njdot/agg.py` `groupby(...).unstack()` on victim type (`vtc`), vehicle damage (`vd`), vehicle egress/type (`vep`); `njdot/cmymc.py` sums `hit_run`/`towed`/`disabled` per `(cc,mc,year)`. So "materialize categorical axes as columns" is an existing pattern, just not yet wired into the S2 cell rollup or a served viewport-query form.

---

## Part A — viewport summary stats + the cube

### Tiers (near-term, crashes-local)

- **Tier 0 — free, pure-FE (no backend change).** `X crashes` + `F/I/O` breakdown + `V vehicles`, by summing the cell rows already fetched for the viewport (the API returns exact per-cell counts). Honors year + geo filters automatically. Caveat: it's "cells intersecting the view", so at low zoom the boundary is fuzzy — fine for a headline stat, not a precise legal count.
- **Tier 1 — tiny ETL.** `Y deaths` (`n_killed`, `n_killed_ped`) — **already computed in the parquet pyramid**, just not copied into the D1 rollup's count columns. Add the columns → deaths-in-viewport is free.
- **Tier 2 — new measures in the same aggregation (not a new stack).** `serious injuries` (KABCO "A", from the person tables — not currently aggregated), `totaled vehicles` (vehicle damage disposition), `hit & runs` (crash flag). Each is one more summed column in `cells.py` → rollup → API → FE.

Victim/vehicle **histograms** (sex, age, make/model) are non-spatial distributions that pair with the **geo filter (county/muni) + years**, not the pixel viewport. Home them in a pre-aggregated cube (extend `cmymc`/`ymccmc` with `sex`, `age-bucket`, `make` top-N, `model` top-N), served from D1/parquet — not client-side DuckDB over the ~25M-row vehicles parquet at statewide scale.

### Cube footer-cost benchmark (2026-09-14)

The pyrmts spec flags the binding constraint: parquet `FileMetaData` carries per-column-chunk stats for **every column × every row group**, and a reader must parse the **whole footer to plan any query** — O(cols × RGs), paid per query, brutal in a CFW. Benchmarked with a synthetic rollup-shaped parquet (200k rows ≈ a fine statewide cell count, ~25 row-groups, sparse int "cuboid" columns at 95% zeros), measuring footer size + parse time (`tmp/cube-footer-bench.py`):

| extra cols | total cols | file MB | footer KB | parse ms | filtered read ms |
|---:|---:|---:|---:|---:|---:|
| 0 | 12 | 2.2 | 30 | 0.14 | — |
| 25 | 37 | 2.8 | 90 | 0.40 | 1.3 |
| 50 | 62 | 3.4 | 150 | 0.66 | 2.3 |
| 100 | 112 | 4.6 | 271 | 1.11 | 2.9 |
| 200 | 212 | 7.0 | 516 | 2.23 | 6.2 |
| 500 | 512 | 14.1 | 1253 | 5.04 | 11.2 |

Findings:
- **Adding dozens of measure columns is cheap** — at 50–100 extra cols the footer is 150–270 KB / ~1 ms parse per file. Fine in a CFW.
- The spec's warned regime (~MB footer, ~5 ms parse) only arrives at **~500 columns**. That's where pyrmts's fleet-manifest mitigation earns its keep.
- **Row-group count is a lever** — footer scales with cols × RGs, so fewer/larger RGs shrink it proportionally.
- Sparse columns compress but aren't free (~24 KB/col at 200k rows, 95%-sparse); footer metadata is the fixed per-col cost.

D1/sqlite serving path (`cells-s2.db`, 377 MB, **4.04M rows** across 18 levels): adding measure columns is storage-cheap (~4–8 MB/col; 5 GB free tier). **But re-importing the extended rollup ≈ 4M row-writes = a D1 write batch → gated to the window-2 D1 budget reset (2026-09-24).** The local build + benchmark touch no D1.

### Verdict

**GO, staged.** Tier-0 ships now (pure FE). Tier-1 (deaths) is ~3 columns already in the pyramid. Tier-2 measures are a bounded `cells.py` change. The **full column-cube (100s of cols)** is where pyrmts's shared machinery is needed — defer, exactly per the pyrmts spec's sequencing. Every D1 import of an extended rollup waits for window-2.

---

## Part B — rendering a mixed-level cover without leaking the grid

> **Superseded for the rendering question by [`map-heatmap-render-strategies.md`](./map-heatmap-render-strategies.md)** (2026-09-14), which grounds the render options in the CarbonPlan `zarr-layer` approach and lays out A/B/C strategies + a benchmark harness. The framing below is retained for context.

### The problem

Bins mode (`www/src/map/StackedCellLayer.tsx`) derives column radius from the S2 cell edge (`S2_EDGE_METERS[resolution]`). A **mixed-level cover** (fine where dense, coarse where sparse — the Phase-2 payload optimization) would therefore render as **fat rural bars next to tiny dense bars** — worse grid-leak than today's uniform bins. Rendering the cover verbatim is the wrong move.

Key reframe: **a mixed-level cover is a data-transfer optimization; it must not dictate the render.** Decouple the display mark from the aggregation cell.

### Options (with tradeoffs)

- **(C) Proportional-symbol columns.** Radius = a function of the cell's *count* in **screen pixels** (clamped), independent of S2 level. Equal-count cells draw equal size regardless of footprint. **Keeps the discrete, pickable, stacked-severity feel.** Smallest change (local to `StackedCellLayer.tsx`). Dense areas need occlusion management.
- **(A) Continuous heatmap / KDE surface.** Feed the **existing `HeatmapLayer`** the aggregated cell centroids (`getWeight` = weighted severity, `radiusPixels` scaled to the coarsest cell in view). Only centroid+weight matter, so **the heterogeneous cover is invisible.** Loses discrete counts + severity decomposition; `HeatmapLayer` isn't pickable → keep an invisible centroid pick-layer beneath.
- **(B) Resample to a uniform display grid.** Redistribute a coarse cell's count across its fine children, render uniform bins. No leak, but fabricates sub-cell structure and partly defeats the payload saving.
- **(D/E) Dot-density / contours.** Grid-agnostic surfaces; poor for exact counts + severity breakdown.

### Framework survey (for "millions of points, interactively")

- **deck.gl aggregation layers** (ScreenGrid/Grid/Hexagon/Heatmap/Contour) GPU-aggregate millions of points — but **client-side, needing raw points shipped**. Off the table at statewide scale, which is exactly why crashes aggregates server-side.
- **CARTO `ClusterTileLayer` / `HeatmapTileLayer`** — "server-aggregate to spatial-index tiles → proportional symbols or KDE surface." This is essentially **what crashes already approximates** with its S2 pyramid + CFW; replicable with `@deck.gl/geo-layers` `TileLayer` over our own pyramid if payload ever outgrows the shard cache (it hasn't).
- **GeoArrow deck.gl** (~3.2M raw points via zero-copy Arrow) and **datashader** (server rasterization, billions, but static images, no picking) are the extremes.
- **Principle across all production systems: never size a mark by its aggregation cell's footprint.**

### Near-term win (independent of Phase 2)

Heatmap **and** Scatter modes today consume **raw crash points** (`effectiveCrashes`, `CrashMap.tsx` ~632–662), not the aggregated cells — so those modes **don't scale statewide**. Wiring Heatmap mode to the aggregated `cells` fixes that now, and doubles as the option-A prototype. (Prototype in progress on a worktree.)

### Recommendation + open decision

1. **Ship the near-term Heatmap-on-cells fix** (small, independent, immediately better; previews the surface look).
2. **Phase 2 (mixed-level cover):** build the server side (`minimalCover` + `PlanLimits`, per-level serving — see [`pyrmts-geo-adoption.md`](./pyrmts-geo-adoption.md) Step 2), and render it via **(C) value-radius columns** and/or **(A) heatmap surface** so it never leaks the grid.

**Open (visual-identity call for the user):** should the mixed-cover Bins view become **(C) proportional-radius columns** (discrete, pickable, stacked-severity) or lean on **(A) the heatmap surface** (smoothest, hides the grid, not pickable)? Decide after seeing the surface live.

---

## Relationship to the load-speed plan

- **Phase 1 (shipped):** bounded-LRU shard cache + ±1-level prefetch (`www/src/map/useCellsApi.ts`). Client-only; removes the perceived per-transition lag.
- **Phase 2 (this doc, Part B + `pyrmts-geo-adoption.md` Step 2):** mixed-level cover + `PlanLimits` — the structural wide-zoom payload fix, plus the grid-agnostic rendering above. Also retires the l17+ statewide 503 (resource-limit) class via preflight.

## Next steps

1. Near-term Heatmap-on-cells (worktree prototype → CIC → ship).
2. Tier-0 viewport stats overlay (pure FE, sums fetched cells).
3. Tier-1 deaths columns in the rollup (D1 import at window-2).
4. Phase 2 server-side mixed-level cover + chosen render (C/A), with the scrns-matrix multi-viewport eval.
5. Tier-2 measures + geo-scoped histograms (pre-agg cube).
6. Full column-cube only if/when column count approaches the hundreds → coordinate the pyrmts fleet-manifest + planner.

## Open questions

- Render approach for mixed covers: **(C)** vs **(A)** (see above).
- Tier-0 boundary semantics: accept "cells intersecting view" fuzziness, or clip to exact viewport?
- Histogram scope: geo (county/muni) only, or also a coarse viewport approximation?
- When (if ever) to promote the local cube to the pyrmts shared machinery — trigger = column count / footer cost crossing the benchmarked threshold.
