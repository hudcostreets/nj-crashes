# S2 Pyramid: Migrating Off H3

Status: draft, not started. Documenting rationale + migration outline; no
implementation planned yet.

## Motivation

Two H3 properties are causing friction:

### 1. Coarse per-level jump — 7× area, ~2.65× linear

Every H3 level is 7× the area of the next, or `√7 ≈ 2.65×` linear scale.
The picker has to snap to whichever level's cell diameter best fits the
current px-per-cell target — but the 2.65× gap between levels lands
outside the "just right" band for a lot of zooms. At z=7.5 embed:

- r7 ≈ 3.7 px per hex → dense enough that the honeycomb pattern reads
  as an artifact
- r8 ≈ 1.4 px per hex → sub-pixel, blurs into density (better) but 7×
  more cells / bandwidth
- Nothing in between

S2's 4× per level (2× linear) means the same zoom range fits ~40% more
distinct levels:

    levels_per_zoom_span(S2) / levels_per_zoom_span(H3) = log(7) / log(4) ≈ 1.40

So we gain finer control over the density/bandwidth trade-off — the
picker can land on a res whose cell diameter is close to the aesthetic
target instead of hopping over it.

### 2. Non-exact parent/child coverage — "boundary triangles"

H3 hex parents don't tile exactly into their 7 children. Each parent has
6 small triangular slivers along its edges (the "boundary triangles" or
BTs) where parent area and 7-children-union geometrically differ —
~5% of parent area. Empirically, ~7–8% of stations land in one BT per
level transition.

Consequences:
- `cellToParent` is exact for cell IDs but *not exact* for points inside
  a BT — a point can lie in one parent hex but its "true" H3 child at a
  finer level maps to a *different* parent.
- Heterogeneous-level coverings (mixing r{N} in one region with r{N+1}
  in another) can't compose cleanly under a monoidal count: you'd
  double-count or miss BT-population depending on which parent's tally
  you sum.
- Aggregation across levels for the same viewport requires either
  duplicated bucketing (H13-style: model each level's BTs first-class)
  or single-resolution queries that pay the coarse-level jump cost.

S2 children exactly tile their parents. Sums roll up losslessly.
Multi-resolution mosaics of a viewport (coarse where cells are sparse,
fine where dense) can be aggregated and compared without BT bookkeeping.

*This is the same reason `ctbk` (`~/c/ctbk`) abandoned H3 for its
station-counting work.*

### 3. Rendering — S2 cells work fine as circles

Square cells warped by Earth curvature look off at high latitudes if
drawn as filled squares. Drawing a **circle inscribed in each S2 cell**
gets us the same density-shaded look as H3 circle mode without the
warping artifact. Every visual property the H3 circle mode currently
has (density, aggregation, aesthetic smoothness at sub-pixel size) is
preserved. Filled-cell mode ("S2Layer" analog to H3HexagonLayer) is a
follow-up if we want a distinct "square-cells" viz.

## What's currently H3-dependent

Roughly ordered by lift required:

| Surface | Currently uses H3 | S2 replacement |
|---|---|---|
| Data pyramid on R2 | `pyramid/r{data_res}/{r4_shard_h3}.parquet`, 10 levels × 34 r4 shards, ~460 MB | S2 cell-id sharded pyramid (level 4 or 5 shard, level 4–15 data), similar total size |
| Cell-to-parent + range math (worker) | `h3-range.ts` — h3 bit math, cell-to-parent, cover-bbox → h3 cells | S2 cell-id range math — well-defined arithmetic, [`s2geometry`](https://s2geometry.io/) has a JS port |
| Client render | deck.gl `H3HexagonLayer` (hex mode), custom `ColumnLayer` with hex-inscribed circles (circle mode) | deck.gl `S2Layer` (square/cell mode), or reuse `ColumnLayer` with S2-inscribed circles |
| Picker | `pickHexResolutionForPixels` walks H3 radii table | `pickS2LevelForPixels` — walk S2 average-cell-diameter table |
| Debug widget | Zoom×res chart uses H3 radii | Same shape, S2 radii table |
| D1 rollup | `cells_r{res}(h3 PK, ...)` × 10 tables | `cells_s2_l{level}(cellid PK, ...)` × 15 or so tables |
| Muni / county polygon clip | S2 already has better spherical geometry primitives for point-in-polygon — actual small win here | Use S2's `S2Polygon.contains` |

None of it is throwaway — every H3 module has a symmetric S2 replacement.
The work is mechanical translation once we've picked the S2 JS lib.

## Migration paths (three options)

### Option A: Cutover

Build the S2 pyramid, switch the worker + client at once. High-risk (any
regression is a full rollback); clean-room outcome.

### Option B: Dual-stack (H3 + S2) behind a URL param

Ship the S2 stack alongside H3. `?grid=h3|s2` switches at runtime.
Client picker picks a level in either grid. Same worker instance serves
both. UI selector in the debug widget.

Pros: A/B compare live, no coordinated rollout, easy to revert.
Cons: worker bundle grows (both cell-id libs), pyramid on R2 grows by
another ~500 MB, ongoing maintenance of two rendering paths.

### Option C: Read-heavy S2 layer over H3 pyramid (rejected)

Would need per-crash lat/lon to re-cell into S2 at query time. Worker
CPU cost is prohibitive at wide zoom. Not viable.

**Recommended: Option B.** Kill H3 mode after S2 has proven out in a
month or so of real use.

## Rough size estimate

Building the S2 pyramid to match H3 coverage (levels ~ 5–15 for
data_res, level ~4 for shards):

- Per-cell rollup (all-years): ~2.4M rows total across 11 levels
  (matches H3 saturation) → ~300 MB SQLite (matches current
  `data/cells/cells.db` = 315 MB)
- Per (cell, year) parquet pyramid: ~460 MB (matches H3)

Wire cost per view: identical (labels are the dominant cost either
way — see `specs/labels-on-demand.md`).

## Worker query — S2 range math

H3's `pickCover` walks `h3-range.ts` to convert bbox → h3 cells at a
target res. S2's equivalent is `S2RegionCoverer` — libs like
`nodes2ts` / `s2-geometry-typescript` expose it. Given a bbox and a
target level, `getCovering()` returns a list of cell IDs plus their
levels. Multi-level covering falls out naturally (not a bolt-on like
H3's `pickCover` shard-tier logic).

## Picker semantics

The picker gains resolution because S2 cells step 2× per level instead
of 2.65×. The picker's "finest r whose diameter ≥ target" logic stays
identical — just walks S2's finer level table instead of H3's.

At z=7.5 embed with the same 2.5 px target:
- H3 r7: 3.7 px, r8: 1.4 px → picks r7
- S2 near-equivalent: level 8: ~4.4 km, level 9: ~2.2 km, level 10:
  ~1.1 km — one of these lands in the 2–3 px sweet spot at z=7.5.
  Specifically, at that mppx, level 9 ≈ 3.3 px, level 10 ≈ 1.7 px.
  Picker picks level 9 (3.3 px) — closer to target than H3's 3.7 or
  1.4 options.

Not dramatically better at every zoom, but consistently in-band vs
sometimes-outside for H3.

## Risks

- **JS S2 library maturity**: `nodes2ts` is unmaintained; alternatives
  `s2-geometry-typescript` and pure-Rust WASM bindings are less
  battle-tested than `h3-js`. Prototype early to shake out gaps.
- **Precision at high levels**: S2 cell IDs are 64-bit ints. JS `number`
  loses precision above 2^53 — mid-latitude levels 22+ are affected.
  Workaround (same as the D1 h3 fix in `queryCellsD1`): pass cell IDs as
  decimal strings, do math in BigInt. We only need levels ~5–15, so
  the ceiling is well under 2^53 — no BigInt needed.
- **Deck.gl `S2Layer`**: exists, but less common than `H3HexagonLayer`.
  Check if it handles our `ColumnLayer`-with-height-scale use case.

## Non-goals

- Not switching `ctbk` or other H3 users in one repo — this is
  crashes-only. `ctbk` will migrate on its own timeline.
- Not implementing "H13"-style BT-aware H3 aggregation as a fallback.
  If we're touching this, we're touching it to fix the root problem,
  not paper over it.
