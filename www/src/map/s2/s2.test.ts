/** Smoke tests: does `nodes2ts` actually behave as our S2 wrappers
 *  claim? These pin the API contract we're relying on (token format,
 *  parent walk, level extraction) before wiring the picker + worker
 *  on top of it. */
import { describe, it, expect } from "vitest"
import {
    S2_DIAMETER_METERS,
    S2_MAX_LEVEL,
    latLngToToken,
    pickS2LevelForPixels,
    tokenLevel,
    tokenToLatLng,
    tokenToParent,
} from "./index"

const JC = { lat: 40.7178, lng: -74.0431 }  // Jersey City centroid

describe("S2 token round-trip", () => {
    it("stays within one cell's diameter of the input at level 14", () => {
        const level = 14
        const token = latLngToToken(JC.lat, JC.lng, level)
        const [lat, lng] = tokenToLatLng(token)
        // Level 14 cell diameter ≈ 957 m. Round-trip error is at most
        // one cell's radius, so ≤ 500 m on each axis for this level.
        const dLat = Math.abs(lat - JC.lat)
        const dLng = Math.abs(lng - JC.lng)
        // Convert lat degrees → meters (~111 km / degree); lng scaled
        // by cos(lat).
        const dLatM = dLat * 111_000
        const dLngM = dLng * 111_000 * Math.cos((JC.lat * Math.PI) / 180)
        const total = Math.sqrt(dLatM * dLatM + dLngM * dLngM)
        expect(total).toBeLessThan(S2_DIAMETER_METERS[level] / 2)
    })

    it("produces a stable hex-string token", () => {
        const t1 = latLngToToken(JC.lat, JC.lng, 12)
        const t2 = latLngToToken(JC.lat, JC.lng, 12)
        expect(t1).toBe(t2)
        expect(t1).toMatch(/^[0-9a-f]+$/)
        expect(t1.length).toBeGreaterThanOrEqual(4)
        expect(t1.length).toBeLessThanOrEqual(16)
    })
})

describe("S2 level introspection", () => {
    it("level of a token matches what we asked for", () => {
        for (const level of [4, 8, 12, 14, 16]) {
            const token = latLngToToken(JC.lat, JC.lng, level)
            expect(tokenLevel(token)).toBe(level)
        }
    })
})

describe("S2 parent walk", () => {
    it("parent at coarser level shares the child's location", () => {
        const child = latLngToToken(JC.lat, JC.lng, 14)
        const parent = tokenToParent(child, 10)
        expect(tokenLevel(parent)).toBe(10)
        // Parent center should be within its own diameter of the
        // child, since the child is inside the parent.
        const [pLat, pLng] = tokenToLatLng(parent)
        const dLatM = Math.abs(pLat - JC.lat) * 111_000
        const dLngM = Math.abs(pLng - JC.lng) * 111_000 * Math.cos((JC.lat * Math.PI) / 180)
        const total = Math.sqrt(dLatM * dLatM + dLngM * dLngM)
        expect(total).toBeLessThan(S2_DIAMETER_METERS[10])
    })

    it("Jersey City and Newark share a level 8 parent (they're close)", () => {
        const jc = latLngToToken(40.7178, -74.0431, 14)
        const newark = latLngToToken(40.7357, -74.1724, 14)
        // Roughly 11 km apart; a level 8 cell is ~61 km wide, so
        // they generally share a parent (occasionally straddle if
        // sitting on a cell boundary — unlikely for this pair).
        const jcParent = tokenToParent(jc, 8)
        const newarkParent = tokenToParent(newark, 8)
        expect(jcParent).toBe(newarkParent)
    })
})

describe("S2 picker (`pickS2LevelForPixels`)", () => {
    // Pin the picker's output at anchor zooms for NJ latitude. The
    // levels here should track the H3 picker's shape (finer as we
    // zoom in). Computed by hand:
    //     mppx(z, 40.7°) ≈ 156543 · cos(40.7°) / 2^z ≈ 118844 / 2^z
    //     target_m = target_px · mppx
    //     level = finest whose S2 edge ≥ target_m
    // Sanity check on H3 side: at z=7 target=2.5 → r7 (edge 1220m,
    // diameter 2440m ≥ 2320m target) — matches picker.test.ts.
    const NJ_LAT = 40.7
    const cases: Array<[number, number, number]> = [
        // [target_px, zoom, expected_level]
        [2.5, 7,  11],  // statewide — S2 finer than H3 r7 (level 11 edge 3828m ≥ 2320m; level 12 edge 1914m < 2320m)
        [2.5, 10, 14],  // county-ish (level 14 edge 478m ≥ 290m; level 15 edge 239m < 290m)
        [2.5, 13, 17],  // city block, at S2_MAX_LEVEL cap
        [2.5, 16, 17],  // sidewalk-scale, still capped
    ]
    for (const [target, zoom, expected] of cases) {
        it(`target=${target}px z=${zoom} lat=${NJ_LAT} → l${expected}`, () => {
            const picked = pickS2LevelForPixels(target, zoom, NJ_LAT)
            // Allow ±1 slack — S2_DIAMETER_METERS are averages and cells
            // vary ~15% by latitude, so boundary zooms straddle levels.
            expect(Math.abs(picked - expected)).toBeLessThanOrEqual(1)
        })
    }

    it("is monotone-non-decreasing across the zoom range", () => {
        let prev = -1
        for (let z = 6; z <= 18; z += 0.25) {
            const l = pickS2LevelForPixels(2.5, z, NJ_LAT)
            expect(l).toBeGreaterThanOrEqual(prev)
            prev = l
        }
    })

    it("stays within [0, S2_MAX_LEVEL] bounds", () => {
        // Extreme wide zoom → coarsest end; extreme deep → finest.
        expect(pickS2LevelForPixels(2.5, 3, NJ_LAT)).toBeGreaterThanOrEqual(0)
        expect(pickS2LevelForPixels(2.5, 22, NJ_LAT)).toBeLessThanOrEqual(S2_MAX_LEVEL)
    })
})
