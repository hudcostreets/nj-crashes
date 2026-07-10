/** Verify `s2-range.ts` matches the client's `nodes2ts` on every
 *  operation it exposes — token round-trip, level extraction, parent
 *  walk, and range-for-cell. `nodes2ts` is our ground truth for the
 *  wire format, since it's what the client uses and its tokens match
 *  Python `s2sphere` byte-for-byte (verified in `njdot/tests/test_s2.py`).
 */
import { describe, it, expect } from "vitest"
import { S2LatLng, S2CellId } from "nodes2ts"
import {
    S2_LEAF_LEVEL,
    s2IdToToken,
    s2LevelOf,
    s2LsbForLevel,
    s2Parent,
    s2RangeForCell,
    s2RangeForCellToken,
    s2TokenToId,
} from "./s2-range"

/** Range of NJ latitudes + longitudes, sampled coarsely for the
 *  cross-lib checks. Reference points: Jersey City, Camden, Trenton,
 *  Newark, Cape May. */
const NJ_POINTS: Array<[number, number, string]> = [
    [40.7178, -74.0431, "Jersey City"],
    [39.9526, -75.1180, "Camden"],
    [40.2170, -74.7429, "Trenton"],
    [40.7357, -74.1724, "Newark"],
    [38.9351, -74.9060, "Cape May"],
]

/** Get an S2 cell id at `level` for a lat/lng, via nodes2ts. Returned
 *  as bigint to match the s2-range.ts API. */
function ntsIdAt(lat: number, lng: number, level: number): bigint {
    const cell = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint()).parentL(level)
    return BigInt(cell.toToken() === "X" ? 0 : "0x" + cell.toToken().padEnd(16, "0"))
}

describe("token ↔ id round-trip matches nodes2ts", () => {
    it("agrees on token → id → token at every level for every NJ point", () => {
        for (const [lat, lng, _] of NJ_POINTS) {
            for (const level of [4, 6, 8, 10, 12, 14, 16]) {
                const token = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                    .parentL(level).toToken()
                const id = s2TokenToId(token)
                expect(s2IdToToken(id)).toBe(token)
            }
        }
    })

    it("handles the special zero-id token 'X'", () => {
        expect(s2TokenToId("X")).toBe(0n)
        expect(s2IdToToken(0n)).toBe("X")
    })
})

describe("level extraction matches nodes2ts", () => {
    it("s2LevelOf(token → id) == nodes2ts level()", () => {
        for (const [lat, lng, _] of NJ_POINTS) {
            for (const level of [4, 6, 8, 10, 12, 14, 16]) {
                const cell = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                    .parentL(level)
                const id = s2TokenToId(cell.toToken())
                expect(s2LevelOf(id)).toBe(level)
            }
        }
    })
})

describe("parent walk matches nodes2ts", () => {
    it("s2Parent(child, targetLevel) == nodes2ts parentL(targetLevel)", () => {
        for (const [lat, lng, _] of NJ_POINTS) {
            for (const childLevel of [10, 14, 16]) {
                for (const parentLevel of [4, 6, 8]) {
                    if (parentLevel >= childLevel) continue
                    const child = ntsIdAt(lat, lng, childLevel)
                    const parentExpected = ntsIdAt(lat, lng, parentLevel)
                    expect(s2Parent(child, parentLevel)).toBe(parentExpected)
                }
            }
        }
    })
})

describe("`s2LsbForLevel` bit position", () => {
    it("level 30 → LSB 1 (leaf marker at bit 0)", () => {
        expect(s2LsbForLevel(S2_LEAF_LEVEL)).toBe(1n)
    })
    it("level 0 → LSB 2^60 (face-level marker at bit 60)", () => {
        expect(s2LsbForLevel(0)).toBe(1n << 60n)
    })
    it("level N → LSB 2^(2*(30-N)) for various levels", () => {
        for (const level of [4, 8, 12, 16]) {
            expect(s2LsbForLevel(level)).toBe(1n << BigInt(2 * (30 - level)))
        }
    })
})

describe("`s2RangeForCell` correctness", () => {
    it("collapses to a single cell when baseLevel == parentLevel", () => {
        for (const [lat, lng, _] of NJ_POINTS) {
            const id = ntsIdAt(lat, lng, 8)
            expect(s2RangeForCell(id, 8)).toEqual({ lo: id, hi: id })
        }
    })

    it("range at base level 16 CONTAINS the parent's own descendant", () => {
        // Any level-16 cell at the same lat/lng as the parent must sit
        // inside the parent's [lo, hi] range — this is the property
        // that makes the range a valid prefix-pruning filter.
        for (const [lat, lng, _] of NJ_POINTS) {
            for (const parentLevel of [4, 6, 8, 10, 12]) {
                const parent = ntsIdAt(lat, lng, parentLevel)
                const leaf16 = ntsIdAt(lat, lng, 16)
                const { lo, hi } = s2RangeForCell(parent, 16)
                expect(leaf16).toBeGreaterThanOrEqual(lo)
                expect(leaf16).toBeLessThanOrEqual(hi)
            }
        }
    })

    it("range at base level 16 EXCLUDES a level-16 cell from a different level-4 shard", () => {
        // JC and Cape May sit in different level-4 cells (89b vs 89d
        // per `e`'s phase-3 build). Cape May's level-16 cell must be
        // outside JC's level-4 range.
        const jc4 = ntsIdAt(40.7178, -74.0431, 4)
        const cmLeaf = ntsIdAt(38.9351, -74.9060, 16)
        const { lo, hi } = s2RangeForCell(jc4, 16)
        expect(cmLeaf < lo || cmLeaf > hi).toBe(true)
    })

    it("range width scales as 4^(baseLevel - parentLevel)", () => {
        // Sanity: number of level-16 descendants of a level-12 parent
        // should equal 4^(16-12) = 256. Adjacent level-16 cells differ
        // by `2 * child_lsb` (the marker bit is stationary; the change
        // is in the digit block above it), so:
        //     count = (hi - lo) / (2 * child_lsb) + 1
        const parent = ntsIdAt(40.7, -74.0, 12)
        const { lo, hi } = s2RangeForCell(parent, 16)
        const childLsb = s2LsbForLevel(16)
        const count = (hi - lo) / (2n * childLsb) + 1n
        expect(count).toBe(4n ** 4n)  // 4^(16-12) = 256
    })
})

describe("`s2RangeForCellToken` token-flavored wrapper", () => {
    it("produces bounds that bracket the parent's own base-level descendant", () => {
        for (const [lat, lng, _] of NJ_POINTS) {
            const parentToken = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                .parentL(8).toToken()
            const leafToken = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                .parentL(16).toToken()
            const { lo, hi } = s2RangeForCellToken(parentToken, 16)
            // Lex string ≤ / ≥ on 16-char left-padded hex is the same
            // order as bigint ≤ / ≥ — same as the D1 TEXT column will
            // do under `BETWEEN`.
            const pad = (t: string) => t + "0".repeat(16 - t.length)
            expect(pad(lo).localeCompare(pad(leafToken))).toBeLessThanOrEqual(0)
            expect(pad(hi).localeCompare(pad(leafToken))).toBeGreaterThanOrEqual(0)
        }
    })
})
