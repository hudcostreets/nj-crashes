/** Pure functions that drive the hexbin picker.
 *
 *  Extracted from `CrashMapSection` for unit testing — anything that
 *  reads viewState or user state stays there; anything deterministic
 *  from `(zoom, lat, viz, target)` lives here so we can pin its
 *  behavior across zoom/mode sweeps in `picker.test.ts`.
 *
 *  Companion to `pickHexResolutionForPixels` in `CrashMap.tsx` (the
 *  low-level "finest r whose diameter ≥ threshold" walk).
 */
import { metersPerPixel, pickHexResolutionForPixels } from "./CrashMap"
import { H3_RADIUS_METERS } from "./StackedHexLayer"
import { AUTO_RES_BY_ZOOM } from "./autoRes"

export type VizMode = "hex" | "circle"

/** Circle-mode target dot-radius (px) — smooth monotone curve in zoom.
 *  At z=7 (whole-NJ): ~1.2px dots (dense field). At z=17 (street-level):
 *  ~5px (hoverable). Exponent chosen so this grows slower than an H3
 *  cell's inscribed radius (which doubles every zoom), so cell-fit is
 *  preserved as zoom deepens. */
export function circleRadiusPx(zoom: number): number {
    const raw = 1.2 * Math.pow(2, (zoom - 7) * 0.21)
    return Math.min(24, Math.max(1.2, raw))
}

/** Auto-table hex-pixel target: pick a preferred res for the current
 *  zoom bucket, then back-solve to its on-screen diameter (× 0.99
 *  slack so the floor picker snaps to that res reliably).
 *
 *  Bucketing uses `round(zoom)` so half-int zooms fall into the
 *  nearest-int bucket — z=16.97 → key 17 (r13), z=17.98 → key 18 (r14).
 *  Previously used `floor`, which held z=16.7 at r12 and pushed the
 *  r12→r13 transition all the way to z=17.0; users found that
 *  transition too late for how the map felt visually. */
export function autoHexPxTarget(
    zoom: number,
    lat: number,
    autoOverrides: Record<number, number> = {},
): number {
    const z = Math.max(0, Math.min(20, Math.round(zoom)))
    const res = autoOverrides[z] ?? AUTO_RES_BY_ZOOM[z] ?? AUTO_RES_BY_ZOOM[7]
    const mppx = metersPerPixel(zoom, lat)
    const diaPx = (2 * H3_RADIUS_METERS[res]) / mppx
    return Math.min(30, Math.max(1.0, diaPx * 0.99))
}

/** Effective `hexPxTarget` fed into `pickHexResolutionForPixels`.
 *  Circle mode uses the identical picker as hex mode — same res, same
 *  cell count, same fetch. Circle is a pure rendering swap: each cell
 *  is drawn as a circular column clamped to the cell's inscribed
 *  radius. Bandwidth optimizations belong elsewhere (worker-side
 *  aggregation, parquet transport). */
export function hexPxTargetFor(
    viz: VizMode,
    zoom: number,
    lat: number,
    autoOverrides: Record<number, number> = {},
): number {
    void viz  // parity with hex mode
    return autoHexPxTarget(zoom, lat, autoOverrides)
}

/** End-to-end: given (viz, zoom, lat, autoOverrides), return the H3
 *  resolution the picker would select. */
export function pickRes(
    viz: VizMode,
    zoom: number,
    lat: number,
    autoOverrides: Record<number, number> = {},
): number {
    const target = hexPxTargetFor(viz, zoom, lat, autoOverrides)
    return pickHexResolutionForPixels(target, zoom, lat)
}
