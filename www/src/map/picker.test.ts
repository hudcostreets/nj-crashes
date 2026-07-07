/** Pin the hexbin picker's output across a matrix of (viz, zoom, lat).
 *
 *  Guards two things this project has landed and is likely to keep
 *  iterating on:
 *
 *  1. **Hex mode**: `AUTO_RES_BY_ZOOM` calibration. Any edit to the
 *     table shifts a specific (zoom → res) mapping, which shows up
 *     immediately as a broken assertion here.
 *
 *  2. **Circle mode**: the "coarsest-fit" override — when target dot ≥
 *     1.5px, drop to the coarsest res whose inscribed circle can still
 *     fit the dot. Below the threshold, fall through to auto (preserves
 *     rasterized-heatmap behavior at coarse zoom).
 *
 *  Zoom sweep also enforces monotonicity — as zoom deepens, res never
 *  goes coarser (equivalently, `res(z+ε) ≥ res(z)`).
 */
import { describe, it, expect } from "vitest"
import { pickRes, circleRadiusPx, hexPxTargetFor } from "./picker"

const NJ_LAT = 40.7

describe("picker: hex mode auto res per zoom", () => {
    // Anchor points from AUTO_RES_BY_ZOOM. Any drift → this test flags it
    // and the user gets to decide whether to update the golden or revert.
    const cases: Array<[number, number]> = [
        // [zoom, expected_res]
        // Note: at z=7.0 exactly, the 1.0 min clamp on autoTarget pushes
        // the picker one res coarser than the AUTO_RES_BY_ZOOM entry (r8).
        // Auto anchor recovers by z=7.5 with mppx small enough to un-clamp.
        [7.0, 7],   // statewide
        [8.5, 9],   // county-overview
        [10.0, 10], // regional
        [10.94, 10],
        [12.0, 11], // urban
        [13.81, 11],
        [14.0, 12],
        [16.0, 12],
        [16.91, 12],
        [17.0, 13], // street-level
        [18.0, 14],
        [19.0, 15], // deep-zoom
    ]
    for (const [zoom, expected] of cases) {
        it(`z=${zoom} → r${expected}`, () => {
            expect(pickRes("hex", zoom, NJ_LAT)).toBe(expected)
        })
    }
})

describe("picker: circle mode coarsest-fit override", () => {
    // Below the rasterized threshold (target dot < 1.5px), circle mode
    // MUST fall through to hex-mode auto to preserve statewide density
    // paint. Above it, circle can go coarser than hex mode.
    it("z=8.5 (target < 1.5px): matches hex auto (r9, rasterized)", () => {
        expect(circleRadiusPx(8.5)).toBeLessThan(1.5)
        expect(pickRes("circle", 8.5, NJ_LAT)).toBe(pickRes("hex", 8.5, NJ_LAT))
    })

    // Anchor circle-mode picks at every zoom in a table so any drift
    // shows up loud.
    const cases: Array<[number, number, number]> = [
        // [zoom, hex_res, circle_res]
        [8.5, 9, 9],    // rasterized preserved (target < 1.5)
        [8.7, 9, 8],    // one-step jump at threshold crossing (target ≈ 1.53)
        [9.0, 9, 8],
        [10.94, 10, 9], // Bergen — the vp that flagged the picker over-fetch
        [11.0, 10, 9],
        [12.0, 11, 9],
        [13.81, 11, 10], // mid-zoom (DTJC)
        [14.0, 12, 11],
        [16.91, 12, 12], // deep: auto wins (coarsestFit fits inside auto)
        [17.0, 13, 12], // circle stays r12; hex bumps to r13
        [18.0, 14, 13],
        [19.0, 15, 13], // circle strictly coarser at very deep zoom
        [20.0, 15, 14],
    ]
    for (const [zoom, hex, circle] of cases) {
        it(`z=${zoom}: hex=r${hex}, circle=r${circle}`, () => {
            expect(pickRes("hex", zoom, NJ_LAT)).toBe(hex)
            expect(pickRes("circle", zoom, NJ_LAT)).toBe(circle)
        })
    }
})

describe("picker: hex mode monotone (never coarser as we zoom in)", () => {
    // Hex-mode tessellation should never drop res as zoom increases.
    // Circle mode is intentionally *not* monotone at the boundary
    // crossing (z≈8.5 target=1.49→1.55 wants slightly-coarser cells so
    // 1.5px dots fit inscribed instead of clamping to sub-px on r9).
    it("res non-decreasing across z=7 → 20 (hex)", () => {
        let prev = -1
        for (let z = 7; z <= 20; z += 0.1) {
            const r = pickRes("hex", z, NJ_LAT)
            expect(r).toBeGreaterThanOrEqual(prev)
            prev = r
        }
    })
})

describe("picker: circle mode piecewise monotone", () => {
    // Circle mode has ONE legit dropdown at the rasterized→discrete-dot
    // threshold crossing (z≈8.6 for the current curve). Everywhere else
    // it should stay non-decreasing as z increases.
    it("at most one res-drop across z=7 → 20", () => {
        let prev = -1
        let drops = 0
        for (let z = 7; z <= 20; z += 0.1) {
            const r = pickRes("circle", z, NJ_LAT)
            if (r < prev) drops++
            prev = r
        }
        expect(drops).toBeLessThanOrEqual(1)
    })
})

describe("picker: circle mode never picks a res finer than hex mode", () => {
    // Corollary of the "Math.max with auto" guard — circle-mode's data
    // reduction should never accidentally fetch finer cells than hex.
    it("across z=7 → 20", () => {
        for (let z = 7; z <= 20; z += 0.25) {
            const hexRes = pickRes("hex", z, NJ_LAT)
            const circleRes = pickRes("circle", z, NJ_LAT)
            expect(circleRes).toBeLessThanOrEqual(hexRes)
        }
    })
})

describe("picker: circleRadiusPx curve", () => {
    // Anchor the growth curve at a couple of critical zooms.
    it("z=7 → 1.2px (min clamp)", () => {
        expect(circleRadiusPx(7)).toBeCloseTo(1.2, 2)
    })
    it("z=17 → ~5px (hoverable street-level)", () => {
        expect(circleRadiusPx(17)).toBeGreaterThan(4.5)
        expect(circleRadiusPx(17)).toBeLessThan(5.5)
    })
    it("z=20 → capped at 24 (max clamp)", () => {
        expect(circleRadiusPx(20)).toBeLessThanOrEqual(24)
    })
})

describe("picker: hexPxTargetFor stays reasonable", () => {
    // Regardless of viz mode / zoom, target should be within picker's
    // sane range (1..30).
    for (let z = 7; z <= 20; z += 1) {
        it(`z=${z}: 1 ≤ target ≤ 30 in both modes`, () => {
            for (const viz of ["hex", "circle"] as const) {
                const t = hexPxTargetFor(viz, z, NJ_LAT)
                expect(t).toBeGreaterThanOrEqual(1)
                expect(t).toBeLessThanOrEqual(30)
            }
        })
    }
})
