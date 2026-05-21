/** Regression tests for `isInRootCover` — the NJ-membership filter the
 *  cover picker applies to candidate cells.
 *
 *  Guards a statewide-map outage: a statewide cover starts from r2/r3
 *  cells (coarser than the r4 root cover). An earlier filter rejected
 *  every cell coarser than r4 → empty cover → blank statewide map while
 *  county zooms (cover cells ≥ r4) still worked. */
import { describe, it, expect } from "vitest"
import { cellToChildren, cellToParent, latLngToCell } from "h3-js"
import { isInRootCover } from "./h3cover"

const ROOT_RES = 4
const njR4 = latLngToCell(40.7178, -74.0431, ROOT_RES)   // Jersey City
const farR4 = latLngToCell(45.0, -100.0, ROOT_RES)       // mid-continent, off-NJ
const root = new Set([njR4])

describe("isInRootCover", () => {
    it("accepts an r4 cell that is itself a root cell, rejects an off-NJ one", () => {
        expect(isInRootCover(njR4, root, ROOT_RES)).toBe(true)
        expect(isInRootCover(farR4, root, ROOT_RES)).toBe(false)
    })

    it("accepts a finer descendant of a root cell, rejects one off-NJ", () => {
        expect(isInRootCover(cellToChildren(njR4, 8)[0], root, ROOT_RES)).toBe(true)
        expect(isInRootCover(cellToChildren(farR4, 8)[0], root, ROOT_RES)).toBe(false)
    })

    // The statewide-outage regression: cover cells coarser than rootRes.
    it("accepts coarser cells (res < rootRes) that contain a root cell", () => {
        expect(isInRootCover(cellToParent(njR4, 3), root, ROOT_RES)).toBe(true)
        expect(isInRootCover(cellToParent(njR4, 2), root, ROOT_RES)).toBe(true)
    })

    it("rejects coarser cells that contain no root cell", () => {
        expect(isInRootCover(cellToParent(farR4, 3), root, ROOT_RES)).toBe(false)
        expect(isInRootCover(cellToParent(farR4, 2), root, ROOT_RES)).toBe(false)
    })
})
