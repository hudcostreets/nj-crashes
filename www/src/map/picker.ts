/** Pure functions that drive the hexbin picker.
 *
 *  Extracted from `CrashMapSection` for unit testing — anything that
 *  reads viewState or user state stays there; anything deterministic
 *  from `(viewportAreaPx, budget, zoom, lat, viz)` lives here so we
 *  can pin its behavior across viewport/mode sweeps in `picker.test.ts`.
 *
 *  Bins-per-viewport model (spec: `specs/autores-bins-budget.md`).
 *  For a target of `budget` bins filling a viewport of `A_px` pixels,
 *  each hex has area `A_px / budget`; solving for vertex-diameter of
 *  a hex with area `(3√3/8)·d²` gives `d = √(A_px / budget)` — with
 *  the ~1.24 packing constant folded into the swept `budget`. This
 *  keeps on-screen hex size roughly constant across zoom levels,
 *  which bounds both visual density and worker CPU / IO cost.
 *
 *  Companion to `pickHexResolutionForPixels` in `CrashMap.tsx` (the
 *  low-level "finest r whose diameter ≥ threshold" walk). */
import { pickHexResolutionForPixels } from "./CrashMap"
import { pickS2LevelForPixels } from "./s2"

export type VizMode = "hex" | "circle"

/** Which grid the picker + fetch layer operate on. `h3` is the
 *  current production grid; `s2` gates the alternate stack described
 *  in `specs/s2-pyramid.md`. Selected via `?grid=` URL param.
 *  Client-side plumbing lands ahead of the S2 pyramid + worker
 *  support (phases 3-4) — until those land, `grid=s2` computes S2
 *  levels for display but the actual data fetch still uses H3. */
export type Grid = "h3" | "s2"

/** Callers pass the numeric picker output (an H3 resolution or an
 *  S2 level, depending on `grid`) alongside the grid so downstream
 *  consumers know which table + range math applies. */
export type PickerOutput = { grid: Grid; res: number }

/** Default target hex-count filling the map viewport (packing constant
 *  and fill factor folded in; not "populated bins/vp" which is 10-30×
 *  smaller). Chosen so the embed viewport (1280×480 ≈ 614k px²) yields
 *  ~3.5 px per hex — one res coarser than the old zoom-table at the
 *  wide-zoom band, unchanged at mid/street zoom. Per spec, this is the
 *  swept param; `?bins=<N>` URL param overrides for A/B eval. Spec's
 *  {3k,5k,8k} sweep referred to populated bins/vp not viewport tiles,
 *  which are 10-30× denser — hence the ~50k landing here.
 *  See `specs/autores-bins-budget.md`. */
export const BINS_BUDGET = 100000

/** Circle-mode target dot-radius (px) — smooth monotone curve in zoom.
 *  At z=7 (whole-NJ): ~1.2px dots (dense field). At z=17 (street-level):
 *  ~5px (hoverable). Exponent chosen so this grows slower than an H3
 *  cell's inscribed radius (which doubles every zoom), so cell-fit is
 *  preserved as zoom deepens. */
export function circleRadiusPx(zoom: number): number {
    const raw = 1.2 * Math.pow(2, (zoom - 7) * 0.21)
    return Math.min(24, Math.max(1.2, raw))
}

/** Target hex vertex-diameter (px) that yields ~`budget` hexes filling
 *  a viewport of area `viewportAreaPx`. Clamped to [1.0, 30] so the
 *  finest / coarsest ends stay in the picker's usable range. */
export function autoHexPxTarget(
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    const diaPx = Math.sqrt(viewportAreaPx / Math.max(1, budget))
    return Math.min(30, Math.max(1.0, diaPx))
}

/** Effective `hexPxTarget` fed into `pickHexResolutionForPixels`.
 *  Circle mode uses the identical picker as hex mode — same res, same
 *  cell count, same fetch. Circle is a pure rendering swap: each cell
 *  is drawn as a circular column clamped to the cell's inscribed
 *  radius. Bandwidth optimizations belong elsewhere (worker-side
 *  aggregation, parquet transport). */
export function hexPxTargetFor(
    viz: VizMode,
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    void viz  // parity with hex mode
    return autoHexPxTarget(viewportAreaPx, budget)
}

/** End-to-end: given (viz, zoom, lat, viewportAreaPx, budget), return
 *  the H3 resolution the picker would select. `zoom` + `lat` are still
 *  needed downstream by `pickHexResolutionForPixels` to convert the
 *  target diameter (px) into a target diameter (meters) for cell
 *  matching. */
export function pickRes(
    viz: VizMode,
    zoom: number,
    lat: number,
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    const target = hexPxTargetFor(viz, viewportAreaPx, budget)
    return pickHexResolutionForPixels(target, zoom, lat)
}

/** Grid-aware picker. Given a grid + the usual `(viz, zoom, lat,
 *  vpArea, budget)`, returns `{ grid, res }` where `res` is either
 *  an H3 resolution (r5-r15) or an S2 level (l4-l16). The px target
 *  is grid-agnostic — the difference is which cell-diameter table
 *  the walk runs against. */
export function pick(
    grid: Grid,
    viz: VizMode,
    zoom: number,
    lat: number,
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): PickerOutput {
    const target = hexPxTargetFor(viz, viewportAreaPx, budget)
    const res = grid === "s2"
        ? pickS2LevelForPixels(target, zoom, lat)
        : pickHexResolutionForPixels(target, zoom, lat)
    return { grid, res }
}
