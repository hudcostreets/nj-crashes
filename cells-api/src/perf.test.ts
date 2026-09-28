import { describe, it, expect } from "vitest"
import {
    HttpError,
    cellsCacheKey,
    coarsenYearCells,
    decodeTokens,
    parseCellsRequest,
    toColumnarByYear,
    type CountField,
} from "./cells"
import { coalesceRanges, coalescingBuffer, type AsyncBuffer } from "./parquet"
import { Timing } from "./timing"

/** Pure pieces of the mobile-perf work (`specs/map-mobile-perf.md`): R2 read
 *  coalescing, the edge-cache key, Server-Timing, and `group=year`. */

describe("coalesceRanges", () => {
    it("merges ranges within maxGap, keeps far ones apart, sorts", () => {
        expect(coalesceRanges([
            { start: 500, end: 600 },
            { start: 0, end: 100 },
            { start: 150, end: 200 },
            { start: 5000, end: 5100 },
        ], 64, 10_000)).toEqual([
            { start: 0, end: 200 },
            { start: 500, end: 600 },
            { start: 5000, end: 5100 },
        ])
    })

    it("caps a span at maxSpan, but never splits a single oversized range", () => {
        expect(coalesceRanges([
            { start: 0, end: 400 },
            { start: 400, end: 800 },
            { start: 800, end: 900 },
            { start: 900, end: 3000 },
        ], 64, 1000)).toEqual([
            { start: 0, end: 900 },
            { start: 900, end: 3000 },
        ])
    })

    it("absorbs overlapping and contained ranges", () => {
        expect(coalesceRanges([
            { start: 10, end: 50 },
            { start: 0, end: 100 },
            { start: 90, end: 120 },
        ], 0, 10_000)).toEqual([{ start: 0, end: 120 }])
    })
})

describe("coalescingBuffer", () => {
    it("serves a synchronous burst of slices from coalesced reads", async () => {
        const data = new Uint8Array(10_000).map((_, i) => i % 251)
        const reads: Array<[number, number]> = []
        const inner: AsyncBuffer = {
            byteLength: data.length,
            async slice(start, end) {
                reads.push([start, end ?? data.length])
                return data.slice(start, end).buffer
            },
        }
        const buf = coalescingBuffer(inner, 100, 100_000)
        const parts = await Promise.all([
            buf.slice(0, 10),
            buf.slice(50, 60),
            buf.slice(5000, 5004),
            buf.slice(9990),
        ])
        expect(reads).toEqual([[0, 60], [5000, 5004], [9990, 10_000]])
        expect(parts.map(p => [...new Uint8Array(p)])).toEqual([
            [...data.slice(0, 10)],
            [...data.slice(50, 60)],
            [...data.slice(5000, 5004)],
            [...data.slice(9990)],
        ])
    })
})

describe("cellsCacheKey", () => {
    const key = (qs: string, dv = "v1") => cellsCacheKey(new URL(`https://cells.example/v1/cells?${qs}`), dv)

    it("sorts params, normalizes severities, appends data_version", () => {
        expect(key("res=18&cells=89b,89d&severity=pif&years=2011-2013")).toBe(
            "https://cells.example/v1/cells?cells=89b%2C89d&res=18&severities=fip&years=2011-2013&__dv=v1",
        )
    })

    it("maps param orderings (and severity spellings) to one key", () => {
        expect(key("years=2011-2013&severities=ip&res=18&cells=89b")).toBe(key("cells=89b&res=18&severity=pi&years=2011-2013"))
    })

    it("separates data versions", () => {
        expect(key("cells=89b&res=18", "a")).not.toBe(key("cells=89b&res=18", "b"))
    })
})

describe("Timing", () => {
    it("accumulates durations and counters into a Server-Timing header", () => {
        const t = new Timing()
        t.add("r2", 12.4)
        t.add("r2", 30)
        t.count("r2_gets", 2)
        t.count("r2_gets", 4)
        t.note("cache", "miss")
        expect(t.header()).toBe('r2;dur=42, r2_gets;dur=0;desc="6", cache;dur=0;desc="miss"')
    })
})

describe("parseCellsRequest group", () => {
    const parse = (qs: string) => parseCellsRequest(new URL(`https://x/?cells=89b&res=12&${qs}`))

    it("accepts group=year with format=cols", () => {
        expect(parse("format=cols&group=year").group).toBe("year")
    })

    it("accepts max_rows with group=year", () => {
        expect(parse("format=cols&group=year&max_rows=1000").maxRows).toBe(1000)
    })

    it.each([
        ["group=year", "group requires format=cols"],
        ["format=cols&group=month", "group must be 'year'"],
        ["format=cols&max_rows=10", "max_rows requires group=year"],
        ["format=cols&group=year&max_rows=0", "max_rows must be a positive integer"],
    ])("rejects %s", (qs, msg) => {
        let err: HttpError | undefined
        try { parse(qs) } catch (e) { err = e as HttpError }
        expect([err?.status, err?.message]).toEqual([400, msg])
    })
})

type Counts = Record<CountField, number>
const counts = (n_fatal: number, n_inj_ped: number, n_inj_other: number, n_pdo: number): Counts => ({
    n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs: 0, n_killed: 0, n_killed_ped: 0,
})

describe("group=year columnar encoding", () => {
    // Two l18 siblings (l17 parent `89c25128ec`) and one l18 cell elsewhere (parent `89c257497c`).
    const A = "89c25128e9", B = "89c25128eb", C = "89c257497d"
    const cells = new Map([
        [B, new Map([[2012, counts(0, 1, 0, 2)]])],
        [A, new Map([[2013, counts(0, 0, 1, 0)], [2011, counts(1, 0, 0, 3)]])],
        [C, new Map([[2011, counts(0, 0, 0, 1)]])],
    ])
    const env = { res: 18, year_range: [2011, 2013] as [number, number], data_version: "t", source: "pyramid" as const, labels: "nums" as const }

    it("emits distinct sorted cells + flat per-year rows", () => {
        const r = toColumnarByYear(env, cells, ["n_fatal", "n_pdo"])
        expect(decodeTokens(r.cols.cellid)).toEqual([A, B, C])
        expect(r).toEqual({
            ...env, format: "cols", group: "year", cellid_enc: "prefix-hex1", n: 3, n_rows: 4,
            cols: {
                cellid: r.cols.cellid,
                nyears: [2, 1, 1],
                year: [2011, 2013, 2012, 2011],
                n_fatal: [1, 0, 0, 0],
                n_pdo: [3, 0, 2, 1],
            },
        })
    })

    it("coarsens per (parent, year), summing siblings", () => {
        const parent = coarsenYearCells(cells, 17)
        expect([...parent.keys()].sort()).toEqual(["89c25128ec", "89c257497c"])
        expect(Object.fromEntries([...parent.get("89c25128ec")!].sort(([a], [b]) => a - b))).toEqual({
            2011: counts(1, 0, 0, 3),
            2012: counts(0, 1, 0, 2),
            2013: counts(0, 0, 1, 0),
        })
    })
})
