/** Pin the hexbin picker's output across a matrix of (viz, zoom, lat,
 *  viewport, budget).
 *
 *  Guards two things this project has landed and is likely to keep
 *  iterating on:
 *
 *  1. **Bins-per-viewport budget** (`autoHexPxTarget`) — solves for the
 *     hex vertex-diameter that yields ~`budget` bins filling a viewport
 *     of area `A_px`: `d_px = sqrt(A_px / budget)`. See
 *     `specs/autores-bins-budget.md`. Any drift in the formula → these
 *     goldens flag it.
 *
 *  2. **Circle mode == hex mode** for the picker itself (rendering-only
 *     swap). Bandwidth wins live elsewhere (worker-side coarsening,
 *     parquet transport, res-budget calibration).
 *
 *  Zoom sweep also enforces monotonicity — as zoom deepens, res never
 *  goes coarser (equivalently, `res(z+ε) ≥ res(z)`).
 */
import { describe, it, expect } from "vitest"
import { pickRes, circleRadiusPx, hexPxTargetFor, autoHexPxTarget, BINS_BUDGET } from "./picker"

const NJ_LAT = 40.7
// Two canonical canvases, matching `viewportDims` in CrashMapSection:
//   embed (homepage):  1280 × 480 = 614400 px²
//   full-screen:       1920 × 900 ≈ 1728000 px²
const EMBED_AREA = 1280 * 480
const FULL_AREA = 1920 * 900

describe("picker: autoHexPxTarget = sqrt(A/budget), clamped [1, 30]", () => {
    // Exact formula check at a few grid points. `budget` is a pure
    // divisor; the packing constant + fill factor are folded into it.
    const cases: Array<[number, number, number]> = [
        // [viewportAreaPx, budget, expected_diaPx]
        [EMBED_AREA, 5000, Math.sqrt(EMBED_AREA / 5000)],    // ≈ 11.08 px
        [EMBED_AREA, 3000, Math.sqrt(EMBED_AREA / 3000)],    // ≈ 14.31 px
        [EMBED_AREA, 8000, Math.sqrt(EMBED_AREA / 8000)],    // ≈ 8.76 px
        [FULL_AREA, 5000, Math.sqrt(FULL_AREA / 5000)],      // ≈ 18.59 px
        [FULL_AREA, 8000, Math.sqrt(FULL_AREA / 8000)],      // ≈ 14.70 px
    ]
    for (const [area, budget, expected] of cases) {
        it(`A=${area} bins=${budget} → d=${expected.toFixed(2)}px`, () => {
            expect(autoHexPxTarget(area, budget)).toBeCloseTo(expected, 4)
        })
    }
    it("clamps to ≥ 1.0 at extreme high budget", () => {
        expect(autoHexPxTarget(1000, 1_000_000)).toBe(1.0)
    })
    it("clamps to ≤ 30 at extreme low budget", () => {
        expect(autoHexPxTarget(EMBED_AREA, 1)).toBe(30)
    })
    it("default budget matches BINS_BUDGET module const", () => {
        expect(autoHexPxTarget(EMBED_AREA)).toBeCloseTo(Math.sqrt(EMBED_AREA / BINS_BUDGET), 4)
    })
})

describe("picker: pickRes @ default budget across the zoom range", () => {
    // Anchor points at the module-default budget (`BINS_BUDGET`), for the
    // embed viewport at NJ latitude. Any drift → this test flags it and
    // the user gets to decide whether to update the golden or revert.
    //
    // The formula: hex_px(z, r) = 2 × H3_RADIUS_METERS[r] × 2^z / (156543 × cos(lat)),
    // and `pickHexResolutionForPixels` picks the finest r whose diameter ≥
    // target_px. Target_px is constant per (area, budget) — so the picked
    // res grows with zoom because the on-screen hex diameter shrinks per
    // res as we zoom out (and grows as we zoom in).
    const cases: Array<[number, number]> = [
        // [zoom, expected_res] at BINS_BUDGET=100k, embed viewport (614400 px²)
        [7.0, 7],    // statewide — ~4k bins / 0.73MB / ~3.4s per e's curve
        [8.5, 8],    // regional — one coarser than the old table's r9
        [10.0, 9],   // county-ish — matches old table
        [12.0, 10],  // urban
        [14.0, 12],
        [16.0, 13],
        [17.0, 14],  // street-level — one finer than old r13
        [19.0, 15],  // deep-zoom
    ]
    for (const [zoom, expected] of cases) {
        it(`z=${zoom} → r${expected}`, () => {
            expect(pickRes("hex", zoom, NJ_LAT, EMBED_AREA)).toBe(expected)
        })
    }
})

describe("picker: circle mode == hex mode (pure rendering swap)", () => {
    it("hex and circle pick identical res across z=7 → 20", () => {
        for (let z = 7; z <= 20; z += 0.25) {
            expect(pickRes("circle", z, NJ_LAT, EMBED_AREA)).toBe(pickRes("hex", z, NJ_LAT, EMBED_AREA))
        }
    })
})

describe("picker: monotone in zoom (never coarser as we zoom in)", () => {
    for (const viz of ["hex", "circle"] as const) {
        it(`${viz} mode: res non-decreasing across z=7 → 20`, () => {
            let prev = -1
            for (let z = 7; z <= 20; z += 0.1) {
                const r = pickRes(viz, z, NJ_LAT, EMBED_AREA)
                expect(r).toBeGreaterThanOrEqual(prev)
                prev = r
            }
        })
    }
})

describe("picker: lower budget → coarser res at wide zoom", () => {
    // The whole point of the budget knob: at statewide zoom, dropping
    // from 8k → 3k pushes the picker to a coarser res (smaller data
    // volume, faster /cells). This encodes that direction as an
    // invariant so a broken formula that inverted it would fail here.
    const embed = EMBED_AREA
    it("z=8 embed: budget 8k → 5k → 3k picks progressively coarser r", () => {
        const r8k = pickRes("hex", 8, NJ_LAT, embed, 8000)
        const r5k = pickRes("hex", 8, NJ_LAT, embed, 5000)
        const r3k = pickRes("hex", 8, NJ_LAT, embed, 3000)
        expect(r8k).toBeGreaterThanOrEqual(r5k)
        expect(r5k).toBeGreaterThanOrEqual(r3k)
    })
    it("z=13 embed: same directional invariant", () => {
        const r8k = pickRes("hex", 13, NJ_LAT, embed, 8000)
        const r5k = pickRes("hex", 13, NJ_LAT, embed, 5000)
        const r3k = pickRes("hex", 13, NJ_LAT, embed, 3000)
        expect(r8k).toBeGreaterThanOrEqual(r5k)
        expect(r5k).toBeGreaterThanOrEqual(r3k)
    })
})

describe("picker: circleRadiusPx curve", () => {
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

describe("picker: hexPxTargetFor stays in usable range", () => {
    // Both viz modes → same passthrough target. Both canvases + a range
    // of budgets → target should sit inside the picker's usable window.
    for (const area of [EMBED_AREA, FULL_AREA]) {
        for (const budget of [3000, 5000, 8000]) {
            it(`A=${area} bins=${budget}: 1 ≤ target ≤ 30 in both modes`, () => {
                for (const viz of ["hex", "circle"] as const) {
                    const t = hexPxTargetFor(viz, area, budget)
                    expect(t).toBeGreaterThanOrEqual(1)
                    expect(t).toBeLessThanOrEqual(30)
                }
            })
        }
    }
})
