/** Pure functions that drive the cell-bin picker.
 *
 *  Extracted from `CrashMapSection` for unit testing — anything that
 *  reads viewState or user state stays there; anything deterministic
 *  from `(viewportAreaPx, budget, zoom, lat)` lives here so we can pin
 *  its behavior across viewport/mode sweeps in `picker.test.ts`.
 *
 *  Bins-per-viewport model (spec: `specs/autores-bins-budget.md`).
 *  For a target of `budget` bins filling a viewport of `A_px` pixels,
 *  each cell has area `A_px / budget`; solving for the diameter gives
 *  `d = √(A_px / budget)` — with the packing constant folded into the
 *  swept `budget`. This keeps on-screen cell size roughly constant
 *  across zoom levels, which bounds both visual density and worker
 *  CPU / IO cost.
 *
 *  Companion to `pickS2LevelForPixels` in `map/s2` (the low-level
 *  "finest level whose diameter ≥ threshold" walk). */
import { pickS2LevelForPixels, S2_MIN_TARGET_PX, S2_TARGET_FACTOR } from "./s2"

/** Default target cell-count filling the map viewport (packing constant
 *  and fill factor folded in; not "populated bins/vp" which is 10-30×
 *  smaller). Chosen so the embed viewport (1280×480 ≈ 614k px²) yields
 *  ~3.5 px per cell. Per spec, this is the swept param; `?bins=<N>` URL
 *  param overrides for A/B eval. See `specs/autores-bins-budget.md`. */
export const BINS_BUDGET = 100000

/** Target dot-radius (px) — smooth monotone curve in zoom.
 *  At z=7 (whole-NJ): ~1.2px dots (dense field). At z=17 (street-level):
 *  ~5px (hoverable). Exponent chosen so this grows slower than a cell's
 *  inscribed radius (which doubles every zoom), so cell-fit is
 *  preserved as zoom deepens. */
export function circleRadiusPx(zoom: number): number {
    const raw = 1.2 * Math.pow(2, (zoom - 7) * 0.21)
    return Math.min(24, Math.max(1.2, raw))
}

/** Target cell diameter (px) that yields ~`budget` cells filling
 *  a viewport of area `viewportAreaPx`. Clamped to
 *  [`S2_MIN_TARGET_PX`, 30] so the finest / coarsest ends stay in the
 *  picker's usable range. The lower clamp is a tuning knob (not a
 *  constant) because it *binds* for every scoped view — see
 *  `S2_MIN_TARGET_PX`. */
export function autoCellPxTarget(
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    const diaPx = Math.sqrt(viewportAreaPx / Math.max(1, budget))
    return Math.min(30, Math.max(S2_MIN_TARGET_PX, diaPx))
}

/** Effective `cellPxTarget` fed into the picker.
 *
 *  Scaled by `S2_TARGET_FACTOR` (see `map/tuning.json`). Applied here
 *  rather than inside `pickS2LevelForPixels` so snap-buttons that set
 *  `target = level.diameter_in_px` cleanly land on their labelled
 *  level — the picker's strict `≥ target` rule stays a valid inverse. */
export function cellPxTargetFor(
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    return autoCellPxTarget(viewportAreaPx, budget) * S2_TARGET_FACTOR
}

/** End-to-end: given (zoom, lat, viewportAreaPx, budget), return the
 *  S2 level the picker would select. `zoom` + `lat` are needed by
 *  `pickS2LevelForPixels` to convert the target diameter (px) into a
 *  target diameter (meters) for cell matching. */
export function pickRes(
    zoom: number,
    lat: number,
    viewportAreaPx: number,
    budget: number = BINS_BUDGET,
): number {
    const target = cellPxTargetFor(viewportAreaPx, budget)
    return pickS2LevelForPixels(target, zoom, lat)
}
