/** Tests for what survives of the v2 module after the H3-era fetch
 *  planner was removed (`specs/h3-removal.md`): `bboxFromViewport`.
 *  The picker / no-chunky-surprise sweeps moved to `picker.test.ts`
 *  (S2 levels) when `pickFetchPlanV2` was deleted as dead code. */
import { describe, it, expect } from "vitest"
import { bboxFromViewport } from "./v2"

describe("bboxFromViewport", () => {
    it("returns a bbox containing the camera point", () => {
        const lat = 40.7, lon = -74.0
        const bb = bboxFromViewport(lat, lon, 11, 1280, 480, 0)
        expect(bb[0]).toBeLessThan(lon)
        expect(bb[2]).toBeGreaterThan(lon)
        expect(bb[1]).toBeLessThan(lat)
        expect(bb[3]).toBeGreaterThan(lat)
    })

    it("inflates vertically with pitch", () => {
        const lat = 40.7, lon = -74.0
        const bb0 = bboxFromViewport(lat, lon, 11, 1280, 480, 0)
        const bb45 = bboxFromViewport(lat, lon, 11, 1280, 480, 45)
        const h0 = bb0[3] - bb0[1]
        const h45 = bb45[3] - bb45[1]
        expect(h45).toBeGreaterThan(h0)
    })
})
