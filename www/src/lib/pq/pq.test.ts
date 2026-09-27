import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { condSkips, matchFilter, type Filter } from "./filter"
import { groupSum, sortRows } from "./ops"
import { planRead, readRows } from "./query"
import { coalesce, loadParquetFile, type RangeFetch, type RangeRequest } from "./source"

const bytes = readFileSync(join(__dirname, "fixtures/sample.parquet"))
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/** A `RangeFetch` over the fixture, logging each request. */
function memFetch(log: RangeRequest[]): RangeFetch {
    return async req => {
        log.push(req)
        const total = ab.byteLength
        const start = "suffix" in req ? Math.max(0, total - req.suffix) : req.start
        const end = "suffix" in req ? total : req.end
        return { buf: ab.slice(start, end), start, total }
    }
}

/** The fixture, with a footer read too small for the whole file (so data reads are real reads). */
async function open(log: RangeRequest[] = []) {
    return loadParquetFile("mem://sample", memFetch(log), 1024)
}

type Row = { entity: number; name: string; chain: number | null; id: number | null; dt: number; flag: boolean | null }
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`)

describe("loadParquetFile", () => {
    it("reads the footer with one suffix read, plus the missing footer bytes when it's bigger", async () => {
        const log: RangeRequest[] = []
        const file = await open(log)
        const footerLen = new DataView(ab).getUint32(ab.byteLength - 8, true)
        const metaStart = ab.byteLength - 8 - footerLen
        expect(footerLen > 1024 - 8).toBe(true)
        expect(log).toEqual([{ suffix: 1024 }, { start: metaStart, end: ab.byteLength - 1024 }])
        expect(file.byteLength).toBe(ab.byteLength)
        const { "ARROW:schema": _arrow, ...kv } = file.kv
        expect(Object.keys(file.kv)).toEqual(["capped", "ARROW:schema"])
        expect(kv).toEqual({ capped: '{"alpha": 3, "hotel": 2}' })
    })

    it("holds a small file whole after its first read (no further requests)", async () => {
        const log: RangeRequest[] = []
        const file = await loadParquetFile("mem://sample", memFetch(log), 1 << 20)
        const rows = await readRows<Row>(file, { columns: ["entity"], filter: { entity: 9 } })
        expect(rows).toEqual([{ entity: 9 }])
        expect(log).toEqual([{ suffix: 1 << 20 }])
    })
})

describe("planRead: row-group pruning by stats", () => {
    const groupsFor = async (filter: Filter) => planRead(await open(), { filter }).groups

    it("equality", async () => {
        expect(await groupsFor({ entity: 2 })).toEqual([0, 1])
        expect(await groupsFor({ entity: 5 })).toEqual([2])
        expect(await groupsFor({ entity: 42 })).toEqual([])
    })
    it("range", async () => {
        expect(await groupsFor({ entity: { $gte: 6, $lt: 8 } })).toEqual([2, 3])
        expect(await groupsFor({ chain: { $gt: 9.5 } })).toEqual([3])
    })
    it("IN list", async () => {
        expect(await groupsFor({ entity: { $in: [1, 7] } })).toEqual([0, 3])
    })
    it("IS NULL uses null counts", async () => {
        expect(await groupsFor({ chain: null })).toEqual([0, 1, 2])
        expect(await groupsFor({ chain: { $null: false } })).toEqual([0, 1, 2, 3])
    })
    it("OR prunes only when every branch does", async () => {
        expect(await groupsFor({ $or: [{ entity: 1 }, { entity: 9 }] })).toEqual([0, 3])
        expect(await groupsFor({ $or: [{ entity: 1 }, { id: 99 }] })).toEqual([0, 1, 2, 3])
    })
    it("strings (min_value / max_value)", async () => {
        expect(await groupsFor({ name: "foxtrot" })).toEqual([2])
        expect(await groupsFor({ name: { $gte: "go", $lt: "gp" } })).toEqual([3])
    })
    it("columns without stats never prune", async () => {
        expect(await groupsFor({ id: 12 })).toEqual([0, 1, 2, 3])
    })
    it("throws on a filter column the file lacks", async () => {
        await expect(groupsFor({ nope: 1 })).rejects.toThrow("mem://sample: filter column(s) not found: nope")
    })
})

describe("readRows", () => {
    it("returns matching rows, normalized (bigint → number, timestamp → epoch ms)", async () => {
        const rows = await readRows<Row>(await open(), { filter: { entity: 1 } })
        expect(rows).toEqual([
            { entity: 1, name: "alpha", chain: 0.5, id: 10, dt: ms("2020-01-01"), flag: true },
            { entity: 1, name: "alpha", chain: null, id: 11, dt: ms("2020-01-02"), flag: null },
            { entity: 1, name: "alpha", chain: 1.5, id: null, dt: ms("2020-01-03"), flag: false },
        ])
    })

    it("projects to present columns only, filtering / sorting on others", async () => {
        const rows = await readRows<Row>(await open(), {
            columns: ["id", "missing_in_this_build"],
            filter: { entity: { $in: [2, 8] } },
            orderBy: [{ col: "chain", desc: true }],
        })
        expect(rows).toEqual([{ id: 23 }, { id: 22 }, { id: 13 }, { id: 12 }])
    })

    it("reads only the pruned groups' needed column chunks, coalesced", async () => {
        const log: RangeRequest[] = []
        const file = await open(log)
        log.length = 0
        const plan = planRead(file, { columns: ["entity", "id"], filter: { entity: 5 } })
        expect(plan.groups).toEqual([2])
        expect(plan.columns).toEqual(["entity", "id"])
        expect(plan.ranges.length).toBe(2)
        await readRows(file, { columns: ["entity", "id"], filter: { entity: 5 } })
        // `entity` and `id` chunks are < 64 KiB apart: one request.
        expect(log).toEqual([coalesce(plan.ranges, 1 << 16)[0]])
    })

    it("OR with null checks (a span's placed + pinned rows, in one read)", async () => {
        const rows = await readRows<Row>(await open(), {
            columns: ["entity", "chain", "id"],
            filter: { entity: { $lte: 3 }, $or: [{ chain: { $gte: 1, $lt: 3 } }, { chain: null, id: { $ne: 14 } }] },
            orderBy: [r => r.chain === null, "chain", "id"],
        })
        expect(rows).toEqual([
            { entity: 1, chain: 1.5, id: null },
            { entity: 3, chain: 2, id: 15 },
            { entity: 1, chain: null, id: 11 },
        ])
    })

    it("limit", async () => {
        const rows = await readRows<Row>(await open(), { columns: ["entity"], filter: { flag: true }, limit: 2 })
        expect(rows).toEqual([{ entity: 1 }, { entity: 2 }])
    })
})

describe("matchFilter / condSkips", () => {
    it("SQL null semantics: comparisons with null are false", () => {
        expect([{ a: null }, { a: 1 }, { a: 2 }].map(r => matchFilter(r, { a: { $ne: 1 } }))).toEqual([false, false, true])
        expect([{ a: null }, { a: 1 }].map(r => matchFilter(r, { a: null }))).toEqual([true, false])
    })
    it("an all-null chunk can't satisfy a comparison", () => {
        expect(condSkips({ nullCount: 4, numRows: 4 }, { $gte: 0 })).toBe(true)
        expect(condSkips({ nullCount: 4, numRows: 4 }, { $null: true })).toBe(false)
    })
})

describe("ops", () => {
    it("sortRows: nulls last, also descending; stable", () => {
        const rows = [{ k: 2, i: 0 }, { k: null, i: 1 }, { k: 1, i: 2 }, { k: 2, i: 3 }]
        expect(sortRows(rows, ["k"]).map(r => r.i)).toEqual([2, 0, 3, 1])
        expect(sortRows(rows, [{ col: "k", desc: true }]).map(r => r.i)).toEqual([0, 3, 2, 1])
    })
    it("groupSum: GROUP BY … ORDER BY keys", () => {
        const rows = [
            { year: 2021, a: 1, b: 2 },
            { year: 2020, a: 3, b: null },
            { year: 2021, a: 5, b: 7 },
        ]
        expect(groupSum(rows, ["year"], { a: r => r.a, total: r => r.a + (r.b ?? 0) })).toEqual([
            { year: 2020, a: 3, total: 3 },
            { year: 2021, a: 6, total: 15 },
        ])
    })
})
