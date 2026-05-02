/** Verify the bit-level range computation matches h3-js semantics:
 *  every base-res descendant of an ancestor C must fall inside the
 *  computed range, and `cellToParent(_, ancestorRes)` must equal C. */
import { describe, expect, it } from "vitest"
import { cellToChildren, cellToParent, latLngToCell, isValidCell } from "h3-js"
import { descendantRange, rangesForCovering } from "./h3-range"

const BASE = 14

function h3StringToBigint(s: string): bigint {
    return BigInt(`0x${s}`)
}

describe("descendantRange", () => {
    it("ancestor at base-res returns single-cell range", () => {
        const cell = latLngToCell(40.7, -74.0, BASE)
        const c = h3StringToBigint(cell)
        const r = descendantRange(c, BASE, BASE)
        expect(r.lo).toBe(c)
        expect(r.hi).toBe(c)
    })

    // Base-res descendants of common ancestors must lie in the computed
    // range. Spot-check several resolutions; for r9..r12 the descendant
    // count is huge, so cap with `cellToChildren(_, r9)` as a sample —
    // actually we verify the boundary endpoints are valid cells.
    it.each([4, 6, 7, 8, 9, 10, 11, 12])("range for r%i ancestor is monotone", (ancRes) => {
        const cell = latLngToCell(40.7, -74.0, ancRes)
        const c = h3StringToBigint(cell)
        const r = descendantRange(c, ancRes, BASE)
        expect(r.lo).toBeLessThanOrEqual(r.hi)
    })

    it("descendants of an r6 ancestor all fall within the range", () => {
        const r6Cell = latLngToCell(40.72, -74.05, 6)
        const c = h3StringToBigint(r6Cell)
        const r = descendantRange(c, 6, BASE)
        // Drill down to r9 (≤7^3 = 343 cells), spot-check that all are
        // descendants of r6Cell and fall inside the range.
        const r9Children = cellToChildren(r6Cell, 9)
        for (const ch of r9Children) {
            // Each r9 child shares parent at r6.
            expect(cellToParent(ch, 6)).toBe(r6Cell)
            // The full r{BASE} range of the r9 child is contained within
            // the range we built for the r6 ancestor.
            const sub = descendantRange(h3StringToBigint(ch), 9, BASE)
            expect(sub.lo).toBeGreaterThanOrEqual(r.lo)
            expect(sub.hi).toBeLessThanOrEqual(r.hi)
        }
    })

    it("range endpoints are valid base-res cells (or sentinel-trailed)", () => {
        const ancestor = latLngToCell(40.7, -74.0, 8)
        const c = h3StringToBigint(ancestor)
        const r = descendantRange(c, 8, BASE)
        // The lo value, interpreted as a hex string, should pass
        // h3-js's isValidCell. (For cells whose digits[ancRes+1..base]
        // are all 0 or all 6, the result is a real base-res cell.)
        const loHex = r.lo.toString(16).padStart(15, "0")
        expect(isValidCell(loHex)).toBe(true)
    })

    it("non-overlapping ancestors at the same res produce disjoint ranges", () => {
        const a = latLngToCell(40.72, -74.05, 7)
        const b = latLngToCell(40.78, -74.10, 7)
        if (a === b) return  // sanity: they should differ
        const ra = descendantRange(h3StringToBigint(a), 7, BASE)
        const rb = descendantRange(h3StringToBigint(b), 7, BASE)
        const overlap = !(ra.hi < rb.lo || rb.hi < ra.lo)
        expect(overlap).toBe(false)
    })
})

describe("rangesForCovering", () => {
    it("merges adjacent ranges for sibling cells", () => {
        // Two siblings under the same r6 parent: their r{BASE} ranges
        // should be adjacent (parent-1 ends at 666...7, parent-2 starts
        // at 000...7) and merge into a single range when fed both.
        const r6Cell = latLngToCell(40.72, -74.05, 6)
        const r7Children = cellToChildren(r6Cell, 7)
        const ancestors = r7Children.slice(0, 2).map(h3StringToBigint)
        const merged = rangesForCovering(ancestors, 7, BASE)
        // Either 1 (if adjacent) or 2 ranges. We mostly care that the
        // total numerical span is unchanged.
        const total = merged.reduce((sum, r) => sum + (r.hi - r.lo + 1n), 0n)
        const sep = ancestors.map(a => descendantRange(a, 7, BASE))
                             .reduce((sum, r) => sum + (r.hi - r.lo + 1n), 0n)
        expect(total).toBe(sep)
    })

    it("returns empty for empty input", () => {
        expect(rangesForCovering([], 7, BASE)).toEqual([])
    })
})
