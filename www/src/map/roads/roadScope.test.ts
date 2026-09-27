import { describe, expect, it } from "vitest"
import {
    addTotals, blockIndexAt, blockTotals, crashKey, crashTotals, encodeSpan, hasBlockColumn, inclusiveSummary, inSpan, isBlockSpan,
    isCorridorOnly, isCustomSpan, isPinned, memberSpan, parseSpan, pointAtChain, projectToChain, ROAD_SCOPE, scopeAt, scopeLevel,
    snapEnds, snapToBlocks, spanBlockRange, spanBounds, spanEnds, spanPaths, stepScope, stretchAround, summarizeCrashes,
    toCorridorChain, fromCorridorChain, type BlockCounts, type BlockExtent, type ChainPoint, type SpanSel,
} from "./roadScope"
/** West Side Ave (JC)-like blocks: 0.1 mi each over [0, 1], then one long block [1, 2]. */
const blocks: BlockExtent[] = [
    ...Array.from({ length: 10 }, (_, k) => ({
        block: k, chain_lo: k / 10, chain_hi: (k + 1) / 10, from_name: `S${k}`, to_name: `S${k + 1}`,
    })),
    { block: 10, chain_lo: 1, chain_hi: 2, from_name: "S10", to_name: null },
]

describe("span URL", () => {
    it("encodes to 3 decimals, dropping trailing zeros", () => {
        expect(encodeSpan({ lo: 1.46, hi: 1.5320001 })).toBe("1.46-1.532")
        expect(encodeSpan({ lo: 0, hi: 2 })).toBe("0-2")
    })
    it("parses, normalizing reversed ends", () => {
        expect(parseSpan("1.46-1.532")).toEqual({ lo: 1.46, hi: 1.532 })
        expect(parseSpan("2.5-0.25")).toEqual({ lo: 0.25, hi: 2.5 })
    })
    it("rejects malformed and empty spans", () => {
        expect([parseSpan(""), parseSpan(null), parseSpan("1.2"), parseSpan("a-b"), parseSpan("-1-2"), parseSpan("1-1")]).toEqual(
            [null, null, null, null, null, null],
        )
    })
    it("round-trips", () => {
        const s = { lo: 0.123, hi: 4.567 }
        expect(parseSpan(encodeSpan(s))).toEqual(s)
    })
})

describe("blocks", () => {
    it("finds the block containing a chain, clamping off the ends; the last block is closed", () => {
        expect([-1, 0, 0.05, 0.1, 0.99, 1.5, 2, 3].map(c => blockIndexAt(blocks, c))).toEqual([0, 0, 0, 1, 9, 10, 10, 10])
        expect(blockIndexAt([], 1)).toBe(-1)
    })
    it("stretch = ±0.25 mi snapped outward to block ends", () => {
        expect(stretchAround(blocks, 0.57)).toEqual({ lo: 0.3, hi: 0.9 })
        // Near the start: clamped at block 0.
        expect(stretchAround(blocks, 0.05)).toEqual({ lo: 0, hi: 0.3 })
    })
    it("stretch ending exactly on a boundary doesn't take the block beyond", () => {
        expect(stretchAround(blocks, 0.45)).toEqual({ lo: 0.2, hi: 0.7 })
    })
    it("stretch inside one long block adds a neighbour each side", () => {
        expect(stretchAround(blocks, 1.5)).toEqual({ lo: 0.9, hi: 2 })
    })
    it("recognizes single-block spans (within URL rounding)", () => {
        expect([
            isBlockSpan(blocks, { lo: 0.3, hi: 0.4 }),
            isBlockSpan(blocks, { lo: 0.3004, hi: 0.3996 }),
            isBlockSpan(blocks, { lo: 0.3, hi: 0.5 }),
        ]).toEqual([true, true, false])
    })
    it("snaps a span outward to the blocks it touches", () => {
        expect(snapToBlocks(blocks, { lo: 0.33, hi: 0.61 })).toEqual({ lo: 0.3, hi: 0.7 })
        expect(snapToBlocks(blocks, { lo: 0.3, hi: 0.5 })).toEqual({ lo: 0.3, hi: 0.5 })
    })
    it("names a span's cross streets only where it starts / ends at them", () => {
        expect(spanEnds(blocks, { lo: 0.3, hi: 0.5 })).toEqual({ from: "S3", to: "S5" })
        expect(spanEnds(blocks, { lo: 0.33, hi: 0.5 })).toEqual({ from: null, to: "S5" })
    })
    it("puts a gap in the block before it (v5.1: blocks are cut at gaps)", () => {
        // West Side Ave's blocks 51 / 52 (v5.1): 2.78–2.94, a gap (Journal Square), then 3.15–3.38.
        const gapped: BlockExtent[] = [
            { block: 51, chain_lo: 2.782378, chain_hi: 2.942378 },
            { block: 52, chain_lo: 3.153597, chain_hi: 3.3835971 },
        ]
        expect([2.7, 2.8, 2.95, 3.1535, 3.153597, 3.5].map(c => blockIndexAt(gapped, c))).toEqual([0, 0, 0, 0, 1, 1])
    })
    it("finds the block ids a span covers exactly, else null", () => {
        expect([
            spanBlockRange(blocks, { lo: 0.3, hi: 0.4 }),
            spanBlockRange(blocks, { lo: 0.3004, hi: 0.6996 }),
            spanBlockRange(blocks, { lo: 0.9, hi: 2 }),
            spanBlockRange(blocks, { lo: 0.33, hi: 0.5 }),
            spanBlockRange(blocks, { lo: 0.3, hi: 0.55 }),
            spanBlockRange(blocks, { lo: 0.5, hi: 0.3 }),
            spanBlockRange([], { lo: 0, hi: 1 }),
        ]).toEqual([[3, 3], [3, 6], [9, 10], null, null, null, null])
    })
    it("uses block ids, not positions", () => {
        const gapped: BlockExtent[] = [
            { block: 51, chain_lo: 2.782378, chain_hi: 2.942378 },
            { block: 52, chain_lo: 3.153597, chain_hi: 3.3835971 },
        ]
        expect(spanBlockRange(gapped, { lo: 2.782, hi: 3.384 })).toEqual([51, 52])
    })
})

describe("block counts", () => {
    const b = (block: number, n: number, fatal: number, injury: number, killed: number, xs?: [number, number, number, number]): BlockCounts => ({
        block, n_crashes: n, n_fatal: fatal, n_injury: injury, n_killed: killed,
        ...(xs ? { n_crashes_xs: xs[0], n_fatal_xs: xs[1], n_injury_xs: xs[2], n_killed_xs: xs[3] } : {}),
    })
    // West Side Ave blocks 10–12 (Hudson v5.1 dev build): 84 / 106 / 45 crashes, 22 / 23 / 11 xs.
    const v51 = [b(10, 84, 0, 20, 0, [22, 0, 5, 0]), b(11, 106, 1, 30, 1, [23, 1, 6, 2]), b(12, 45, 0, 9, 0, [11, 0, 3, 0])]
    const v50 = [b(10, 84, 0, 20, 0), b(11, 106, 1, 30, 1)]
    it("sums n_* and n_*_xs over a block id range", () => {
        expect([blockTotals(v51, [10, 11]), blockTotals(v51, [12, 12]), blockTotals(v51, [13, 14])]).toEqual([
            { own: { n: 190, fatal: 1, injury: 50, killed: 1 }, xs: { n: 45, fatal: 1, injury: 11, killed: 2 } },
            { own: { n: 45, fatal: 0, injury: 9, killed: 0 }, xs: { n: 11, fatal: 0, injury: 3, killed: 0 } },
            { own: { n: 0, fatal: 0, injury: 0, killed: 0 }, xs: { n: 0, fatal: 0, injury: 0, killed: 0 } },
        ])
    })
    it("has no xs totals for v5.0 blocks", () => {
        expect(blockTotals(v50, [10, 11])).toEqual({ own: { n: 190, fatal: 1, injury: 50, killed: 1 }, xs: null })
    })
    it("detects v5.1 blocks (the `block` column convention) by `n_crashes_xs`", () => {
        expect([hasBlockColumn(v51), hasBlockColumn(v50), hasBlockColumn([])]).toEqual([true, false, false])
    })
})

describe("scope ladder", () => {
    const block3 = { corridor: false, span: { lo: 0.3, hi: 0.4 } }
    const stretch = { corridor: false, span: { lo: 0.1, hi: 0.6 } }
    const corridor = { corridor: true, span: null }
    it("classifies states", () => {
        expect([
            scopeLevel(ROAD_SCOPE, blocks),
            scopeLevel(block3, blocks),
            scopeLevel(stretch, blocks),
            scopeLevel(corridor, blocks),
        ]).toEqual(["road", "block", "stretch", "corridor"])
    })
    it("tells two-point spans from the stretch around their centre", () => {
        expect([
            isCustomSpan(stretch, blocks),
            isCustomSpan({ corridor: false, span: { lo: 0.12, hi: 0.47 } }, blocks),
            isCustomSpan(block3, blocks),
            isCustomSpan(ROAD_SCOPE, blocks),
        ]).toEqual([false, true, false, false])
    })
    it("builds each level around an anchor", () => {
        expect([
            scopeAt("block", 0.35, blocks, false),
            scopeAt("stretch", 0.35, blocks, false),
            scopeAt("road", 0.35, blocks, false),
            scopeAt("corridor", 0.35, blocks, false),
            scopeAt("corridor", 0.35, blocks, true),
            scopeAt("block", 0.35, [], true),
        ]).toEqual([block3, stretch, ROAD_SCOPE, null, corridor, null])
    })
    it("steps wider: block → stretch → road → corridor, stopping at the ends", () => {
        const up = (s: typeof ROAD_SCOPE) => stepScope(s, 1, 0.35, blocks, true)
        expect([up(block3), up(stretch), up(ROAD_SCOPE), up(corridor)]).toEqual([stretch, ROAD_SCOPE, corridor, corridor])
    })
    it("steps narrower: corridor → road → stretch → block, stopping at the ends", () => {
        const down = (s: typeof ROAD_SCOPE) => stepScope(s, -1, 0.35, blocks, true)
        expect([down(corridor), down(ROAD_SCOPE), down(stretch), down(block3)]).toEqual([ROAD_SCOPE, stretch, block3, block3])
    })
    it("skips the corridor level when the road has none", () => {
        expect(stepScope(ROAD_SCOPE, 1, 0.35, blocks, false)).toEqual(ROAD_SCOPE)
    })
    it("steps from a two-point span to the stretch at the anchor (narrower) or the road (wider)", () => {
        const custom = { corridor: false, span: { lo: 0.12, hi: 0.47 } }
        expect([stepScope(custom, -1, 0.35, blocks, true), stepScope(custom, 1, 0.35, blocks, true)]).toEqual([stretch, ROAD_SCOPE])
    })
    it("steps from a corridor span to the whole corridor (narrower keeps the corridor)", () => {
        const cspan = { corridor: true, span: { lo: 1, hi: 2 } }
        expect([stepScope(cspan, -1, 0.35, blocks, true), stepScope(cspan, 1, 0.35, blocks, true)]).toEqual([corridor, cspan])
    })
})

describe("corridor chain", () => {
    // Tonnelle Ave's "US 1 SECONDARY" members: one forward, one reversed.
    const fwd = { entity: 3173, corridor_c0: 5.75, corridor_sign: 1, chain_mi: 0.55 }
    const rev = { entity: 3175, corridor_c0: 7.25, corridor_sign: -1, chain_mi: 0.4 }
    it("maps member chain ↔ corridor chain", () => {
        expect([toCorridorChain(fwd, 0.5), toCorridorChain(rev, 0.25), fromCorridorChain(fwd, 6.25), fromCorridorChain(rev, 7)]).toEqual(
            [6.25, 7, 0.5, 0.25],
        )
    })
    it("clips a corridor span to each member", () => {
        expect([
            memberSpan(fwd, { lo: 6, hi: 7 }),
            memberSpan(rev, { lo: 6, hi: 7 }),
            memberSpan(rev, { lo: 7, hi: 7.125 }),
            memberSpan(fwd, { lo: 1, hi: 2 }),
        ]).toEqual([{ lo: 0.25, hi: 0.55 }, { lo: 0.25, hi: 0.4 }, { lo: 0.125, hi: 0.25 }, null])
    })
})

describe("geometry", () => {
    // A straight east-west road at the equator: 0.01° lon ≈ 1113 m; chain 0..1 over 4 points on
    // one SRI, then a second SRI continuing with a gap (both joined by chain, not by path).
    const pt = (sri: string, mp: number, chain: number, lon: number): ChainPoint => ({ sri, mp, chain, lon, lat: 0 })
    const points = [
        pt("A", 0, 0, 0), pt("A", 0.1, 0.1, 0.001), pt("A", 0.2, 0.2, 0.002), pt("A", 0.3, 0.3, 0.003),
        pt("B", 0, 0.5, 0.005), pt("B", 0.1, 0.6, 0.006),
    ]
    const round = (xs: [number, number][][]) => xs.map(p => p.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]))
    it("projects a click onto the nearest segment, interpolating its chain", () => {
        const hit = projectToChain(points, [0.0015, 0.0001], 50)!
        expect([Number(hit.chain.toFixed(6)), Number(hit.meters.toFixed(1)), hit.lngLat.map(v => Number(v.toFixed(6)))]).toEqual(
            [0.15, 11.1, [0.0015, 0]],
        )
    })
    it("misses beyond the radius", () => {
        expect(projectToChain(points, [0.0015, 0.001], 50)).toBe(null)
    })
    it("clips paths to a span, splitting across SRIs", () => {
        expect(round(spanPaths(points, { lo: 0.05, hi: 0.55 }))).toEqual([
            [[0.0005, 0], [0.001, 0], [0.002, 0], [0.003, 0]],
            [[0.005, 0], [0.0055, 0]],
        ])
    })
    it("clips within one segment", () => {
        expect(round(spanPaths(points, { lo: 0.12, hi: 0.18 }))).toEqual([[[0.0012, 0], [0.0018, 0]]])
    })
    it("finds the point at a chain", () => {
        expect(pointAtChain(points, 0.25)!.map(v => Number(v.toFixed(6)))).toEqual([0.0025, 0])
        expect(pointAtChain(points, 0.4)).toBe(null)
    })
})

describe("crash rows", () => {
    it("keys crashes by id, else the 4-field PK", () => {
        expect([
            crashKey({ id: 7, year: 2020, cc: 9, mc: 6, case: "X" }),
            crashKey({ id: null, year: 2024, cc: 9, mc: 6, case: "24-1" }),
        ]).toEqual(["#7", "2024/9/6/24-1"])
    })
    const bySpan = (lo: number, hi: number, hiClosed = true): SpanSel => ({ span: { lo, hi }, hiClosed, blocks: null })
    it("selects placed crashes by chain and pinned ones by overlap", () => {
        const sel = bySpan(1, 2)
        expect([
            inSpan({ chain: 1.5 }, sel),
            inSpan({ chain: 2.5 }, sel),
            inSpan({ chain: null, chain_lo: 1.9, chain_hi: 2.1 }, sel),
            inSpan({ chain: null, chain_lo: 2.1, chain_hi: 2.2 }, sel),
            inSpan({ chain: null, chain_lo: null, chain_hi: null }, sel),
            inSpan({ chain: null, chain_lo: 1.9, chain_hi: 2.1, corridor_only: true }, sel),
        ]).toEqual([true, false, true, false, false, false])
    })
    it("selects placed crashes by block id for block-aligned spans (v5.1), whatever their chain", () => {
        // Blocks 3–4 = [0.3, 0.5]. A crash at the node at 0.3 is in block 3 even when its own point
        // is before it; one at the node at 0.5 is in block 5 even when its point is before it.
        const sel: SpanSel = { span: { lo: 0.3, hi: 0.5 }, hiClosed: false, blocks: [3, 4] }
        expect([
            inSpan({ chain: 0.2999, block: 3 }, sel),
            inSpan({ chain: 0.4999, block: 5 }, sel),
            inSpan({ chain: 0.45, block: 4 }, sel),
            inSpan({ chain: 0.45, block: null }, sel),
            inSpan({ chain: null, chain_lo: 0.49, chain_hi: 0.51 }, sel),
            inSpan({ chain: null, chain_lo: 0.49, chain_hi: 0.51, corridor_only: true }, sel),
        ]).toEqual([true, false, true, false, true, false])
    })
    it("tells pinned and corridor-only rows apart", () => {
        const rows = [
            { chain: null, chain_lo: 1, chain_hi: 1.1 },
            { chain: null, chain_lo: 1, chain_hi: 1.1, corridor_only: true },
            { chain: null, chain_lo: null, chain_hi: null, corridor_only: true },
            { chain: 1, chain_lo: null, chain_hi: null, corridor_only: false },
        ]
        expect(rows.map(r => [isPinned(r), isCorridorOnly(r)])).toEqual([[true, false], [false, true], [false, true], [false, false]])
    })
    it("puts crashes at the span's end intersection in the next block, except at the road's end", () => {
        const span = { lo: 1, hi: 2 }
        const at = (chain: number, closed: boolean) => inSpan({ chain }, bySpan(1, 2, closed))
        expect([at(0.99995, false), at(2, false), at(1.99995, false), at(1.9998, false), at(2, true), at(2.00005, true)]).toEqual(
            [true, false, false, true, true, true],
        )
        expect(spanBounds(span, false)).toEqual({ min: 0.9999, max: 1.9999, maxInclusive: false })
    })
    it("snaps span ends onto the block boundaries they round", () => {
        const bs = [{ block: 0, chain_lo: 0, chain_hi: 1.4600000381 }, { block: 1, chain_lo: 1.4600000381, chain_hi: 2.0473780632 }]
        expect(snapEnds(bs, { lo: 1.46, hi: 2.047 })).toEqual({ lo: 1.4600000381, hi: 2.0473780632 })
        expect(snapEnds(bs, { lo: 1.2, hi: 2.047 })).toEqual({ lo: 1.2, hi: 2.0473780632 })
    })
    it("summarizes crash rows per month × severity", () => {
        const c = (iso: string, severity: string, tk: number, ti: number, unplaced = false, corridor_only = false, own_entity: number | null = null) =>
            ({ dt: Date.parse(iso), severity, tk, ti, unplaced, corridor_only, own_entity })
        const rows = [
            c("2020-01-05T10:00:00Z", "i", 0, 2),
            c("2020-01-20T10:00:00Z", "i", 0, 1, true, true),
            c("2020-01-20T10:00:00Z", "f", 1, 0),
            c("2019-12-31T23:00:00Z", "p", 0, 0),
            // Another road's corridor-only crash at an intersection: not this road's `n_corridor_only`.
            c("2019-12-30T23:00:00Z", "p", 0, 0, false, true, 7),
        ]
        expect(summarizeCrashes(rows, r => r.unplaced)).toEqual([
            { year: 2019, month: 12, severity: "p", n: 2, tk: 0, ti: 0, n_unplaced: 0, n_corridor_only: 0 },
            { year: 2020, month: 1, severity: "f", n: 1, tk: 1, ti: 0, n_unplaced: 0, n_corridor_only: 0 },
            { year: 2020, month: 1, severity: "i", n: 2, tk: 0, ti: 3, n_unplaced: 1, n_corridor_only: 1 },
        ])
    })
    it("adds other roads' intersection crashes for the inclusive view", () => {
        expect(inclusiveSummary([
            { year: 2020, severity: "i", n: 5, tk: 0, ti: 6, n_xs: 2, tk_xs: 0, ti_xs: 3 },
            { year: 2021, severity: "p", n: 1, tk: 0, ti: 0 },
        ])).toEqual([
            { year: 2020, severity: "i", n: 7, tk: 0, ti: 9, n_xs: 2, tk_xs: 0, ti_xs: 3 },
            { year: 2021, severity: "p", n: 1, tk: 0, ti: 0 },
        ])
    })
    it("totals crashes, fatal / injury crashes and killed", () => {
        const t = crashTotals([{ severity: "f", tk: 2 }, { severity: "i", tk: 0 }, { severity: "p", tk: null }])
        expect(t).toEqual({ n: 3, fatal: 1, injury: 1, killed: 2 })
        expect([addTotals(t, t), addTotals(t, null)]).toEqual([{ n: 6, fatal: 2, injury: 2, killed: 4 }, t])
    })
})
