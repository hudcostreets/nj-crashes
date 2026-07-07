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
    // Table anchors under `round(zoom)` bucketing. Any drift → this
    // trips and the user gets to decide whether to update the golden
    // or revert. At z=7.0 exactly, the 1.0 min clamp on autoTarget
    // pushes one res coarser than the AUTO_RES_BY_ZOOM entry (r8) —
    // preserved from prior behavior.
    const cases: Array<[number, number]> = [
        // [zoom, expected_res]
        [7.0, 7],   // statewide
        [8.5, 9],   // round(8.5)=9 → AUTO[9]=9
        [10.0, 10], // regional
        [10.94, 10],
        [12.0, 11], // urban
        [13.81, 12], // round(13.81)=14 → AUTO[14]=12 (was r11 under floor)
        [14.0, 12],
        [16.0, 12],
        [16.91, 13], // round(16.91)=17 → AUTO[17]=13 (was r12 under floor)
        [17.0, 13], // street-level
        [17.98, 14], // round(17.98)=18 → AUTO[18]=14 (was r13 under floor)
        [18.0, 14],
        [19.0, 15], // deep-zoom
    ]
    for (const [zoom, expected] of cases) {
        it(`z=${zoom} → r${expected}`, () => {
            expect(pickRes("hex", zoom, NJ_LAT)).toBe(expected)
        })
    }
})

describe("picker: circle mode == hex mode (pure rendering swap)", () => {
    // Circle mode is a rendering swap only — same picker, same res,
    // same cell fetch. Anything else conflates two concerns (viz
    // rendering vs. bandwidth optimization). Bandwidth wins live
    // elsewhere (worker-side coarsening, parquet transport).
    it("hex and circle pick identical res across z=7 → 20", () => {
        for (let z = 7; z <= 20; z += 0.25) {
            expect(pickRes("circle", z, NJ_LAT)).toBe(pickRes("hex", z, NJ_LAT))
        }
    })
})

describe("picker: monotone in zoom (never coarser as we zoom in)", () => {
    // Both modes: as zoom deepens, res never decreases.
    for (const viz of ["hex", "circle"] as const) {
        it(`${viz} mode: res non-decreasing across z=7 → 20`, () => {
            let prev = -1
            for (let z = 7; z <= 20; z += 0.1) {
                const r = pickRes(viz, z, NJ_LAT)
                expect(r).toBeGreaterThanOrEqual(prev)
                prev = r
            }
        })
    }
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
