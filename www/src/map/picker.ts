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
 *  integer-zoom bucket, then back-solve to its on-screen diameter
 *  (× 0.99 slack so the floor picker snaps to that res reliably). */
export function autoHexPxTarget(
    zoom: number,
    lat: number,
    autoOverrides: Record<number, number> = {},
): number {
    const z = Math.max(0, Math.min(20, Math.floor(zoom)))
    const res = autoOverrides[z] ?? AUTO_RES_BY_ZOOM[z] ?? AUTO_RES_BY_ZOOM[7]
    const mppx = metersPerPixel(zoom, lat)
    const diaPx = (2 * H3_RADIUS_METERS[res]) / mppx
    return Math.min(30, Math.max(1.0, diaPx * 0.99))
}

/** Threshold (px) below which we stay in the *rasterized-heatmap*
 *  regime — target dot < ~1.5px, cells blend into density paint. Above
 *  this we're in the *discrete-dot* regime where we can safely drop to
 *  a coarser resolution whose inscribed circle still fits the target
 *  dot, saving bandwidth without changing the visual. */
const CIRCLE_RASTERIZED_THRESHOLD_PX = 1.5

/** Effective `hexPxTarget` fed into `pickHexResolutionForPixels`.
 *  Layer over the auto target with viz-mode overrides. */
export function hexPxTargetFor(
    viz: VizMode,
    zoom: number,
    lat: number,
    autoOverrides: Record<number, number> = {},
): number {
    const auto = autoHexPxTarget(zoom, lat, autoOverrides)
    if (viz !== "circle") return auto
    const target = circleRadiusPx(zoom)
    if (target < CIRCLE_RASTERIZED_THRESHOLD_PX) return auto
    // inscribed_radius ≥ target_radius ⇔ hex_diameter ≥ 4·target/√3.
    // Accept up to ~15% clamp (dot rendered slightly smaller than
    // target) rather than jump two H3 levels for a strict fit — the
    // difference between "1.5px" and "1.3px" dots is invisible; the
    // difference between r7 and r8 cell counts is 7×.
    const coarsestFit = ((4 * target) / Math.sqrt(3)) / 1.15
    return Math.max(auto, coarsestFit)
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
