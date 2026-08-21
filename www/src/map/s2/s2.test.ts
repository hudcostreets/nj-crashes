/** Smoke tests: does `nodes2ts` actually behave as our S2 wrappers
 *  claim? These pin the API contract we're relying on (token format,
 *  parent walk, level extraction) before wiring the picker + worker
 *  on top of it. */
import { describe, it, expect } from "vitest"
import {
    S2_DIAMETER_METERS,
    S2_MAX_LEVEL,
    binIntoS2Cells,
    latLngToToken,
    pickS2LevelForPixels,
    tokenLevel,
    tokenToLatLng,
    tokenToParent,
} from "./index"
import type { StackableCrash } from "../StackedHexLayer"

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
        [2.5, 13, 17],  // city block (level 17 edge 60m ≥ 36m; level 18 edge 30m < 36m)
        [2.5, 14, 18],  // street segment (level 18 edge 30m ≥ 18m; level 19 edge 15m < 18m)
        [2.5, 15, 19],  // street zoom — phase 7's target (level 19 edge 15m ≥ 9m)
        [2.5, 16, 20],  // crosswalk-scale (level 20 edge 7.5m ≥ 4.5m; level 21 3.75m < 4.5m)
        [2.5, 17, 21],  // phase 8's target: H3 r14 parity (level 21 edge 3.75m ≥ 2.3m)
    ]
    for (const [target, zoom, expected] of cases) {
        it(`target=${target}px z=${zoom} lat=${NJ_LAT} → l${expected}`, () => {
            const picked = pickS2LevelForPixels(target, zoom, NJ_LAT)
            // Allow ±1 slack — S2_DIAMETER_METERS are averages and cells
            // vary ~15% by latitude, so boundary zooms straddle levels.
            expect(Math.abs(picked - expected)).toBeLessThanOrEqual(1)
        })
    }

    it("reaches l21 at deep street zoom (phase 8's target — H3 r14 parity)", () => {
        // Phase 8 built out the l21 pyramid so the picker could reach that
        // level at street zoom. The `S2_PICK_MULT` fudge (l21: 0.4) later
        // shifted the exact crossover from z=16.8 to z≈17 — at z=16.8 the
        // picker prefers l20 (7.5m, 7px effective) over l21 rendered as
        // invisible 1-2px dots. l21 stays reachable a hair deeper.
        expect(pickS2LevelForPixels(2.5, 18, NJ_LAT)).toBe(21)
    })

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

describe("binIntoS2Cells", () => {
    // Fixture: 2 co-located crashes on JFK Blvd (plus a near-neighbor
    // that shares their l16 cell) + 1 at the JC centroid. Expected
    // tokens/centers computed directly via nodes2ts and pinned.
    const crash = (lat: number, lon: number, severity: "i" | "f" | "p", extra: Partial<StackableCrash> = {}): StackableCrash =>
        ({ lat, lon, severity, tk: severity === "f" ? 1 : 0, pk: 0, pi: 0, ...extra })
    const crashes: StackableCrash[] = [
        crash(40.7441, -74.0585, "f", { road: "ROUTE 501" }),
        crash(40.7441, -74.0585, "i", { road: "ROUTE 501" }),
        crash(40.7442, -74.0586, "p"),
        crash(40.7178, -74.0431, "i"),
    ]

    it("bins into S2 tokens at the requested level, with exact centers", () => {
        const bins = binIntoS2Cells(crashes, 16).sort((a, b) => a.h3.localeCompare(b.h3))
        expect(bins.map(b => ({
            h3: b.h3,
            center: b.center.map(x => x.toFixed(10)),
            fatal: b.fatal,
            otherInj: b.otherInj,
            pdo: b.pdo,
            total: b.total,
            topRoute: b.topRoute,
        }))).toEqual([
            {
                h3: "89c250b1d",
                center: ["-74.0424971533", "40.7171943818"],
                fatal: 0, otherInj: 1, pdo: 0, total: 1,
                topRoute: undefined,
            },
            {
                h3: "89c2573e7",
                center: ["-74.0586528693", "40.7441928613"],
                fatal: 1, otherInj: 1, pdo: 1, total: 3,
                topRoute: "ROUTE 501",
            },
        ])
        // Every bin's token really is an S2 token at the requested level
        // (the regression this API exists to prevent: H3 tokens under an
        // "S2" label).
        expect(bins.map(b => tokenLevel(b.h3))).toEqual([16, 16])
    })
})
