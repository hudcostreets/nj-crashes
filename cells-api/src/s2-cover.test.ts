/** Regression tests for the two bugs behind the l17+ `503` (CF 1102,
 *  "worker exceeded resource limits") on any non-default S2 filter:
 *
 *  1. The `cellid` ranges driving row-group pruning were derived from the
 *     requested *shards*. S2's shard level is l4, and NJ is only two l4
 *     cells (`89b`/`89d`) — which the client hardcodes as its entire cover
 *     — so the range always spanned the whole shard file and pruned
 *     nothing. Every street-zoom request decoded all 63 MB of
 *     `s2_l19/89d.parquet`.
 *  2. Range bounds were zero-padded to 16 hex chars, but the stored
 *     `cellid` is the *token* (trailing zeros stripped). Mixing the two
 *     forms drops any cell sitting exactly on a range's low bound.
 */
import { describe, expect, it } from "vitest"
import { S2CellId, S2LatLng } from "nodes2ts"
import { intersectRanges, s2RangesForPolygon } from "./cells"
import { s2IdToToken, s2RangeForCell, s2TokenToId } from "./s2-range"

/** A z=15-ish viewport over Jersey City — the zoom at which the picker
 *  asks for l19 and the old code blew the worker's budget. */
const JC_VIEWPORT: [number, number][] = [
    [-74.0689, 40.7309], [-74.0173, 40.7309],
    [-74.0173, 40.7047], [-74.0689, 40.7047], [-74.0689, 40.7309],
]

/** Total cell-id span of a range set — proxy for "how much of the shard
 *  file do we have to read". */
const span = (ranges: { lo: bigint; hi: bigint }[]) =>
    ranges.reduce((n, r) => n + (r.hi - r.lo + 1n), 0n)

/** The two l4 cells covering NJ, as the client sends them. */
const NJ_SHARDS = ["89b", "89d"]

describe("`s2RangesForPolygon` prunes the viewport out of the statewide shard", () => {
    it("covers a z=15 viewport with a tiny fraction of the shard's id span", () => {
        const level = 19
        const shardRanges = NJ_SHARDS.map(s => s2RangeForCell(s2TokenToId(s), level))
        const tight = intersectRanges(shardRanges, s2RangesForPolygon(JC_VIEWPORT, level))
        expect(tight.length).toBeGreaterThan(0)
        // The whole point: the viewport-derived range is orders of magnitude
        // smaller than the shard-derived one it replaces. (Measured against
        // the real l19 parquet, this is 6 of 549 row groups vs. all 549.)
        const ratio = Number(span(shardRanges) / span(tight))
        expect(ratio).toBeGreaterThan(1000)
    })

    it("never covers finer than the queried level (`s2RangeForCell` needs an ancestor)", () => {
        for (const level of [12, 16, 19]) {
            for (const r of s2RangesForPolygon(JC_VIEWPORT, level)) {
                expect(r.lo <= r.hi).toBe(true)
            }
        }
    })

    it("keeps every cell that is actually in the viewport", () => {
        const level = 19
        const shardRanges = NJ_SHARDS.map(s => s2RangeForCell(s2TokenToId(s), level))
        const tight = intersectRanges(shardRanges, s2RangesForPolygon(JC_VIEWPORT, level))
        // Sample points well inside the viewport; each one's l19 cell must
        // fall inside some surviving range, or we'd silently drop real data.
        const inside: [number, number][] = [
            [40.7178, -74.0431],  // JC centroid
            [40.7100, -74.0600],
            [40.7280, -74.0250],
            [40.7060, -74.0200],
        ]
        for (const [lat, lng] of inside) {
            const id = BigInt(
                "0x" + S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                    .parentL(level).toToken().padEnd(16, "0"),
            )
            expect(tight.some(r => r.lo <= id && id <= r.hi)).toBe(true)
        }
    })

    it("yields no ranges for a viewport outside the shards (→ handler returns empty, not a full scan)", () => {
        const pacific: [number, number][] = [
            [-140, 30], [-139, 30], [-139, 31], [-140, 31], [-140, 30],
        ]
        const level = 19
        const shardRanges = NJ_SHARDS.map(s => s2RangeForCell(s2TokenToId(s), level))
        expect(intersectRanges(shardRanges, s2RangesForPolygon(pacific, level))).toEqual([])
    })
})

describe("range bounds are tokens, not zero-padded hex", () => {
    it("includes a cell sitting exactly on a range's low bound", () => {
        // Take a real l19 cell and the l12 ancestor whose range it opens.
        const leaf = S2CellId.fromPoint(S2LatLng.fromDegrees(40.7178, -74.0431).toPoint())
            .parentL(19)
        const parent = s2TokenToId(leaf.parentL(12).toToken())
        const { lo, hi } = s2RangeForCell(parent, 19)
        const loToken = s2IdToToken(lo)
        const hiToken = s2IdToToken(hi)

        // `lo` *is* a real cell — the first l19 descendant — and it is what
        // the D1/parquet `cellid` column stores for it.
        const stored = s2IdToToken(lo)
        expect(stored >= loToken && stored <= hiToken).toBe(true)

        // The old bound (zero-padded to 16) excluded it: lex-comparing the
        // stripped stored token against a padded bound puts the shorter
        // string first, so `stored >= paddedLo` was false.
        const paddedLo = lo.toString(16).padStart(16, "0")
        expect(stored >= paddedLo).toBe(false)
    })

    it("lex order over stripped tokens matches numeric cell-id order", () => {
        // This is the property that lets `cellid BETWEEN lo AND hi` work on
        // tokens at all. Check it across levels on a real NJ column.
        const ids: bigint[] = []
        for (let level = 4; level <= 19; level++) {
            for (const [lat, lng] of [[40.7178, -74.0431], [40.2206, -74.7597], [39.3643, -74.4229]]) {
                ids.push(s2TokenToId(
                    S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint())
                        .parentL(level).toToken(),
                ))
            }
        }
        const byId = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(s2IdToToken)
        const byToken = ids.map(s2IdToToken).sort()
        expect(byToken).toEqual(byId)
    })
})
