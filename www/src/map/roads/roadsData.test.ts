import { describe, expect, it } from "vitest"
import { nearestRoad, roadPaths, roadSegments, type RoadPoint } from "./roadsData"

// ~0.00147° lat ≈ 163 m: consecutive tenth-mile MP points on a north-south route.
const DLAT = 0.00147
const LON = -74.05
const lat0 = 40.75
const pt = (sri: string, mp: number, name: string, lon: number, lat: number, entity = 0): RoadPoint =>
    ({ sri, mp, sld_name: name, name, subt: 6, entity, alias: null, lon, lat })

const longRoad: RoadPoint[] = [0, 1, 2].map(i => pt("LONG", i / 10, "US 1", LON, lat0 + i * DLAT))
// A short side street whose only point sits 30 m east of the long road's midpoint between MP 0.0 and 0.1.
const side: RoadPoint = pt("SIDE", 0, "WALLER ST", LON + 30 / (111_320 * Math.cos(lat0 * Math.PI / 180)), lat0 + DLAT / 2, 1)

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
        const gap: RoadPoint = pt("LONG", 0.9, "US 1", LON, lat0 + 3 * DLAT)
        const segs = roadSegments([...longRoad, gap, side])
        expect(segs.map(({ a, b }) => [a.sri, a.mp, b.mp])).toEqual([
            ["LONG", 0, 0.1],
            ["LONG", 0.1, 0.2],
            ["SIDE", 0, 0],  // single-point route → degenerate segment
        ])
        expect(roadPaths([...longRoad, gap]).map(p => p.length)).toEqual([3])
    })
})
