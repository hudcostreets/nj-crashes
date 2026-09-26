import { describe, expect, it } from "vitest"
import { nearestRoad, roadPaths, roadSegments, type RoadPoint } from "./roadsData"

// ~0.00147° lat ≈ 163 m: consecutive tenth-mile MP points on a north-south route.
const DLAT = 0.00147
const LON = -74.05
const lat0 = 40.75

const longRoad: RoadPoint[] = [0, 1, 2].map(i => ({ sri: "LONG", mp: i / 10, sld_name: "US 1", lon: LON, lat: lat0 + i * DLAT }))
// A short side street whose only point sits 30 m east of the long road's midpoint between MP 0.0 and 0.1.
const side: RoadPoint = { sri: "SIDE", mp: 0, sld_name: "WALLER ST", lon: LON + 30 / (111_320 * Math.cos(lat0 * Math.PI / 180)), lat: lat0 + DLAT / 2 }

describe("nearestRoad", () => {
    it("picks the road whose segment passes under the cursor, not the nearest MP point", () => {
        // Cursor on the long road, halfway between its MP 0.0 and 0.1 points (~80 m from each).
        const cursor: [number, number] = [LON, lat0 + DLAT / 2]
        const segs = roadSegments([...longRoad, side])
        expect(nearestRoad(segs, cursor, 50)?.sri).toBe("LONG")
    })

    it("returns null beyond maxMeters", () => {
        const segs = roadSegments(longRoad)
        const cursor: [number, number] = [LON + 0.01, lat0]  // ~840 m east
        expect(nearestRoad(segs, cursor, 50)).toBe(null)
    })
})

describe("roadSegments / roadPaths", () => {
    it("joins consecutive MPs and breaks at MP gaps", () => {
        const gap: RoadPoint = { sri: "LONG", mp: 0.9, sld_name: "US 1", lon: LON, lat: lat0 + 3 * DLAT }
        const segs = roadSegments([...longRoad, gap, side])
        expect(segs.map(({ a, b }) => [a.sri, a.mp, b.mp])).toEqual([
            ["LONG", 0, 0.1],
            ["LONG", 0.1, 0.2],
            ["SIDE", 0, 0],  // single-point route → degenerate segment
        ])
        expect(roadPaths([...longRoad, gap]).map(p => p.length)).toEqual([3])
    })
})
