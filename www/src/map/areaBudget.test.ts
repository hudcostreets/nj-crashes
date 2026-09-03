/** Guards the statewide bins-budget clip (`areaBudget.ts`).
 *
 *  The bug this was extracted to pin: statewide embed budgeted bins over
 *  the raw viewport, so a wider window (more empty ocean/PA letterbox
 *  around height-bound NJ) stepped the picker *coarser* over the
 *  identical map. `clippedAreaPx` clips the budget area to NJ's on-screen
 *  extent, making the pick width-independent. */
import { describe, it, expect } from "vitest"
import { fitBoundsToView, lerpView } from "./CrashMap"
import { cellPxTargetFor } from "./picker"
import { pickS2LevelForPixels } from "./s2"
import { bboxRing, clippedAreaPx } from "./areaBudget"

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]
const BUDGET = 100000
/** Mirror of `CrashMapSection`'s `STATEWIDE_VIEW` (full-screen camera). */
const STATEWIDE_VIEW = {
    mobile:  { latitude: 39.90, longitude: -74.60, zoom: 7.85, pitch: 45, bearing: 0 },
    desktop: { latitude: 39.9695, longitude: -74.6721, zoom: 7.18, pitch: 36, bearing: -1 },
}

const pick = (view: { latitude: number; longitude: number; zoom: number; pitch: number }, vpw: number, vph: number): number => {
    const areaPx = clippedAreaPx(vpw * vph, bboxRing(STATE_BBOX), view, vpw, vph)
    return pickS2LevelForPixels(cellPxTargetFor(areaPx, BUDGET), view.zoom, view.latitude)
}

/** Statewide *embed*: width clamped to 1280, fixed 480px tall, 3D pitch. */
const embedStatewideLevel = (rawWidth: number): number => {
    const vpw = Math.min(rawWidth, 1280), vph = 480
    return pick(fitBoundsToView(STATE_BBOX, vpw, vph, 45), vpw, vph)
}
/** Statewide *full-screen* overview: real window, hand-tuned camera. */
const fullscreenStatewideLevel = (w: number, h: number): number =>
    pick(lerpView(STATEWIDE_VIEW, w), w, h)

describe("statewide bins-budget", () => {
    it("embed picks the same S2 level (l13) across viewport widths", () => {
        // Pre-fix these were l12/l12/l11/l11/l11 (coarser as the window grew
        // past the 1280 cap); the clip makes every width land on l13.
        const levels = [768, 1000, 1280, 1440, 1920].map(embedStatewideLevel)
        expect(levels).toEqual([13, 13, 13, 13, 13])
    })

    it("full-screen overview picks the same S2 level (l13) across window sizes", () => {
        // Pre-fix: l11/l11/l10 (coarser as the window grew). The clip is
        // self-limiting, so the zoomed-out overview lands on l13 too.
        const levels = ([[1440, 900], [1920, 1080], [2560, 1400]] as const).map(([w, h]) => fullscreenStatewideLevel(w, h))
        expect(levels).toEqual([13, 13, 13])
    })

    it("leaves the zoomed-in full-screen pick unchanged (clip is a no-op there)", () => {
        // Zoomed inside NJ: the ring covers the viewport, so the clip can't
        // refine — the pick matches the unclipped budget (the payload cliff
        // is pre-existing, not introduced by the clip).
        const zoomedIn = { latitude: 40.72, longitude: -74.06, zoom: 12, pitch: 45 }
        const clipped = pickS2LevelForPixels(cellPxTargetFor(clippedAreaPx(2560 * 1400, bboxRing(STATE_BBOX), zoomedIn, 2560, 1400), BUDGET), zoomedIn.zoom, zoomedIn.latitude)
        const unclipped = pickS2LevelForPixels(cellPxTargetFor(2560 * 1400, BUDGET), zoomedIn.zoom, zoomedIn.latitude)
        expect(clipped).toBe(unclipped)
    })
})

describe("clippedAreaPx", () => {
    const raw = 1280 * 480
    const overview = fitBoundsToView(STATE_BBOX, 1280, 480, 45)

    it("returns the raw area with no clip ring", () => {
        expect(clippedAreaPx(raw, undefined, overview, 1280, 480)).toBe(raw)
    })

    it("returns the raw area with no camera", () => {
        expect(clippedAreaPx(raw, bboxRing(STATE_BBOX), null, 1280, 480)).toBe(raw)
    })

    it("shrinks the area when the scope is smaller than the viewport", () => {
        // Whole-state overview: NJ occupies only part of a wide viewport.
        expect(clippedAreaPx(raw, bboxRing(STATE_BBOX), overview, 1280, 480)).toBeLessThan(raw)
    })

    it("is self-limiting — never grows the area, and is a ~no-op when zoomed inside the scope", () => {
        // Zoom 12 over central NJ: the viewport sits wholly inside the
        // state bbox, so the ring covers it and the clip barely bites.
        const zoomedIn = { latitude: 40.3, longitude: -74.5, zoom: 12, pitch: 45 }
        const clipped = clippedAreaPx(raw, bboxRing(STATE_BBOX), zoomedIn, 1280, 480)
        expect(clipped).toBeLessThanOrEqual(raw)
        expect(clipped).toBeGreaterThanOrEqual(raw * 0.99)
    })
})
