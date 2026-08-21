/** Tests for the exported pure helpers in `useCellsApi` (the hook
 *  itself is exercised end-to-end via the map pages). */
import { describe, it, expect } from "vitest"
import { polygonAreaM2, clipPolygonToBbox } from "./useCellsApi"

describe("polygonAreaM2", () => {
    it("0.01°×0.01° square at lat 40 → kx·ky·1e-4 exactly", () => {
        const ring: [number, number][] = [
            [-74.00, 40.00], [-73.99, 40.00], [-73.99, 40.01], [-74.00, 40.01],
        ]
        // Planar model: kx = 111320·cos(40.005°) (lat-extent midpoint),
        // ky = 110540.
        const kx = 111_320 * Math.cos((40.005 * Math.PI) / 180)
        const expected = kx * 0.01 * 110_540 * 0.01
        expect(polygonAreaM2(ring) / expected).toBeCloseTo(1, 7)
    })

    it("closed ring (last === first) gives the same area as open", () => {
        const open: [number, number][] = [
            [-74.00, 40.00], [-73.99, 40.00], [-73.99, 40.01], [-74.00, 40.01],
        ]
        const closed: [number, number][] = [...open, open[0]]
        expect(polygonAreaM2(closed)).toBeCloseTo(polygonAreaM2(open), 6)
    })

    it("degenerate rings → 0", () => {
        expect(polygonAreaM2([])).toBe(0)
        expect(polygonAreaM2([[-74, 40], [-73.99, 40]])).toBe(0)
    })

    it("clip ∩ bbox then area: half-covered square halves the area", () => {
        const ring: [number, number][] = [
            [-74.00, 40.00], [-73.99, 40.00], [-73.99, 40.01], [-74.00, 40.01],
        ]
        const full = polygonAreaM2(ring)
        // Bbox covering the western half of the square.
        const half = clipPolygonToBbox(ring, [-74.00, 40.00, -73.995, 40.01])
        expect(polygonAreaM2(half) / full).toBeCloseTo(0.5, 3)
    })
})
