/** Pin the cell-bin picker's output across a matrix of (zoom, lat,
 *  viewport, budget).
 *
 *  Guards two things this project has landed and is likely to keep
 *  iterating on:
 *
 *  1. **Bins-per-viewport budget** (`autoCellPxTarget`) — solves for the
 *     cell diameter that yields ~`budget` bins filling a viewport of
 *     area `A_px`: `d_px = sqrt(A_px / budget)`. See
 *     `specs/autores-bins-budget.md`. Any drift in the formula → these
 *     goldens flag it.
 *
 *  2. **The shipped tuning values** (`map/tuning.json`:
 *     `targetFactor` + per-level `pickMult`) — the zoom→level anchors
 *     below bake them in, so an accidental tuning.json edit fails here
 *     and a deliberate one updates the goldens consciously (via
 *     `/tune`'s Save + a test run).
 *
 *  Zoom sweep also enforces monotonicity — as zoom deepens, the level
 *  never goes coarser (equivalently, `level(z+ε) ≥ level(z)`).
 */
import { describe, it, expect } from "vitest"
import { pickRes, circleRadiusPx, cellPxTargetFor, autoCellPxTarget, BINS_BUDGET } from "./picker"
import { S2_TARGET_FACTOR } from "./s2"

const NJ_LAT = 40.7
// Two canonical canvases, matching `viewportDims` in CrashMapSection:
//   embed (homepage):  1280 × 480 = 614400 px²
//   full-screen:       1920 × 900 ≈ 1728000 px²
const EMBED_AREA = 1280 * 480
const FULL_AREA = 1920 * 900

describe("picker: autoCellPxTarget = sqrt(A/budget), clamped [1, 30]", () => {
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
            expect(autoCellPxTarget(area, budget)).toBeCloseTo(expected, 4)
        })
    }
    it("clamps to ≥ 1.0 at extreme high budget", () => {
        expect(autoCellPxTarget(1000, 1_000_000)).toBe(1.0)
    })
    it("clamps to ≤ 30 at extreme low budget", () => {
        expect(autoCellPxTarget(EMBED_AREA, 1)).toBe(30)
    })
    it("default budget matches BINS_BUDGET module const", () => {
        expect(autoCellPxTarget(EMBED_AREA)).toBeCloseTo(Math.sqrt(EMBED_AREA / BINS_BUDGET), 4)
    })
})

describe("picker: pickRes @ default budget across the zoom range", () => {
    // Anchor points at the module-default budget (`BINS_BUDGET`), for the
    // embed viewport at NJ latitude, with the shipped tuning
    // (targetFactor 0.85; pickMult l20=0.55, l21=0.4). Any drift → this
    // test flags it and the user decides golden-update vs revert.
    const cases: Array<[number, number]> = [
        // [zoom, expected_s2_level] at BINS_BUDGET=100k, embed viewport
        [7.0, 11],   // statewide
        [8.5, 13],   // regional
        [10.0, 14],  // county-ish
        [12.0, 16],  // urban
        [14.0, 18],  // muni
        [16.0, 20],  // near-street (l21 gated by pickMult 0.4 until ~z17+)
        [17.0, 20],
        [19.0, 21],  // deep street zoom
    ]
    for (const [zoom, expected] of cases) {
        it(`z=${zoom} → l${expected}`, () => {
            expect(pickRes(zoom, NJ_LAT, EMBED_AREA)).toBe(expected)
        })
    }
})

describe("picker: monotone in zoom (never coarser as we zoom in)", () => {
    it("level non-decreasing across z=7 → 20", () => {
        let prev = -1
        for (let z = 7; z <= 20; z += 0.1) {
            const l = pickRes(z, NJ_LAT, EMBED_AREA)
            expect(l).toBeGreaterThanOrEqual(prev)
            prev = l
        }
    })
})

describe("picker: lower budget → coarser level at wide zoom", () => {
    // The whole point of the budget knob: at statewide zoom, dropping
    // from 8k → 3k pushes the picker to a coarser level (smaller data
    // volume, faster /cells). This encodes that direction as an
    // invariant so a broken formula that inverted it would fail here.
    const embed = EMBED_AREA
    it("z=8 embed: budget 8k → 5k → 3k picks progressively coarser levels", () => {
        const l8k = pickRes(8, NJ_LAT, embed, 8000)
        const l5k = pickRes(8, NJ_LAT, embed, 5000)
        const l3k = pickRes(8, NJ_LAT, embed, 3000)
        expect(l8k).toBeGreaterThanOrEqual(l5k)
        expect(l5k).toBeGreaterThanOrEqual(l3k)
    })
    it("z=13 embed: same directional invariant", () => {
        const l8k = pickRes(13, NJ_LAT, embed, 8000)
        const l5k = pickRes(13, NJ_LAT, embed, 5000)
        const l3k = pickRes(13, NJ_LAT, embed, 3000)
        expect(l8k).toBeGreaterThanOrEqual(l5k)
        expect(l5k).toBeGreaterThanOrEqual(l3k)
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

describe("picker: cellPxTargetFor = autoCellPxTarget × S2_TARGET_FACTOR", () => {
    for (const area of [EMBED_AREA, FULL_AREA]) {
        for (const budget of [3000, 5000, 8000]) {
            it(`A=${area} bins=${budget}: exact scale + usable range`, () => {
                const t = cellPxTargetFor(area, budget)
                expect(t).toBeCloseTo(autoCellPxTarget(area, budget) * S2_TARGET_FACTOR, 6)
                expect(t).toBeGreaterThanOrEqual(1 * S2_TARGET_FACTOR)
                expect(t).toBeLessThanOrEqual(30)
            })
        }
    }
})
