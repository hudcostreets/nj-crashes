/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import {
    type CellOut,
    type CellsColsYearResponse,
    type CellsRequest,
    type CellsResponse,
    _resetByYearCache,
    handleCellsRequest,
    s2RangesForPolygon,
} from "./cells"
import { BY_YEAR_BASE, BY_YEAR_FIELDS } from "./by-year"
import { _resetManifestCache } from "./manifest"
import { _resetFooterCache, readParquetFromR2 } from "./parquet"
import { s2IdToToken } from "pyrmts-geo"

/** Year-filtered requests served from D1's `by_year` column
 *  (specs/cells-d1-years.md): the query + response, the fallbacks, and —
 *  when the local pyramid is present — cell-for-cell parity with the
 *  pyramid path on real data. */

const MANIFEST = { data_version: "test", year_range: [2001, 2025] }
const PYRAMID_ROOT = resolve(__dirname, "../../data/cells")

/** Fake R2: a synthetic manifest, plus pyramid files from the local DVX
 *  checkout when present (absent ⇒ `head` → null ⇒ an empty shard). */
function bucket(): R2Bucket {
    const path = (key: string) => `${PYRAMID_ROOT}/${key.replace(/^cells\//, "")}`
    return {
        async head(key: string) {
            const p = path(key)
            return existsSync(p) ? { size: readFileSync(p).length } : null
        },
        async get(key: string, opts?: { range?: { offset: number; length: number } }) {
            if (key === "cells/manifest.json") return { async text() { return JSON.stringify(MANIFEST) } }
            const buf = readFileSync(path(key))
            const off = opts?.range?.offset ?? 0
            const len = opts?.range?.length ?? buf.length - off
            const slice = buf.subarray(off, off + len)
            return { async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) } }
        },
    } as unknown as R2Bucket
}

type Row = Record<string, string | number | null>

/** Fake D1: returns `rows` for every statement (ignores WHERE), or throws
 *  `error`; records each SQL statement. */
function d1(rows: Row[], error?: string) {
    const sqls: string[] = []
    const db = {
        prepare(sql: string) {
            sqls.push(sql)
            return {
                async all() {
                    if (error) throw new Error(error)
                    return { results: rows }
                },
            }
        },
    } as unknown as D1Database
    return { db, sqls }
}

const WHERE = "WHERE (cellid BETWEEN '89c000004' AND '89dfffffc')"

describe("D1 path, year sub-range", () => {
    beforeEach(() => { _resetManifestCache(); _resetByYearCache() })

    // `89c2572c`: PDO in 2005 + 2013, a fatal in 2019. `89c25734`: injuries
    // in 2013 only. `89c2573c`: a blank-severity crash only (no severity
    // counts in any year ⇒ dropped).
    const ROWS: Row[] = [
        { cellid: "89c25734", by_year: "13:4,3,2,1" },
        { cellid: "89c2572c", by_year: "5:2,1;13:3,4;19:1,,,,1,2,1" },
        { cellid: "89c2573c", by_year: "13:1" },
    ]
    const REQ: CellsRequest = { cells: ["89d"], res: 15, labels: "nums", yearRange: [2010, 2019] }

    it("sums each cell's in-range years (rows)", async () => {
        const { db, sqls } = d1(ROWS)
        expect(await handleCellsRequest(bucket(), "cells", REQ, db)).toEqual({
            res: 15, year_range: [2010, 2019], data_version: "test", source: "d1", labels: "nums",
            cells: [
                { cellid: "89c25734", n_fatal: 0, n_inj_ped: 1, n_inj_other: 2, n_pdo: 3, n_vehs: 4, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c2572c", n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 4, n_vehs: 4, n_killed: 2, n_killed_ped: 1, fatal_years: [2019] },
            ],
        })
        expect(sqls).toEqual([`SELECT cellid, by_year FROM cells_s2_l15 ${WHERE}`])
    })

    it("applies the severity filter and selects labels alongside", async () => {
        const { db, sqls } = d1(ROWS.map(r => ({ ...r, sld_name: "Kennedy Blvd", cross_sld_name: null, mun: "Jersey City", county: "Hudson" })))
        expect(await handleCellsRequest(bucket(), "cells", { ...REQ, labels: "full", yearRange: [2001, 2013], severities: new Set(["p"]) }, db)).toEqual({
            res: 15, year_range: [2001, 2013], data_version: "test", source: "d1", labels: "full",
            cells: [
                { cellid: "89c25734", n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 3, n_vehs: 4, n_killed: 0, n_killed_ped: 0, sld_name: "Kennedy Blvd", mun: "Jersey City", county: "Hudson" },
                { cellid: "89c2572c", n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 5, n_vehs: 5, n_killed: 0, n_killed_ped: 0, sld_name: "Kennedy Blvd", mun: "Jersey City", county: "Hudson" },
            ],
        })
        expect(sqls).toEqual([`SELECT cellid, by_year, sld_name, cross_sld_name, mun, county FROM cells_s2_l15 ${WHERE}`])
    })

    it("format=cols&group=year: one row per in-range year with a requested severity", async () => {
        const { db, sqls } = d1(ROWS)
        const r = await handleCellsRequest(bucket(), "cells", { ...REQ, format: "cols", group: "year", yearRange: [2001, 2025], severities: new Set(["f", "i"]) }, db)
        expect(r).toEqual({
            res: 15, year_range: [2001, 2025], data_version: "test", source: "d1", labels: "nums",
            format: "cols", group: "year", cellid_enc: "prefix-hex1", n: 2, n_rows: 2,
            cols: {
                cellid: ["089c2572c", "634"],
                nyears: [1, 1],
                year: [2019, 2013],
                n_fatal: [1, 0], n_inj_ped: [0, 1], n_inj_other: [0, 2], n_pdo: [0, 0],
                n_vehs: [1, 4], n_killed: [2, 0], n_killed_ped: [1, 0],
            },
        } satisfies CellsColsYearResponse)
        expect(sqls).toEqual([`SELECT cellid, by_year FROM cells_s2_l15 ${WHERE}`])
    })

    it("all-years requests keep reading the all-years columns", async () => {
        const { db, sqls } = d1([])
        await handleCellsRequest(bucket(), "cells", { ...REQ, yearRange: [2001, 2025] }, db)
        expect(sqls).toEqual([
            `SELECT cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped, fatal_years FROM cells_s2_l15 ${WHERE}`,
        ])
    })

    it("falls back to the pyramid on a table without `by_year`, and stops asking for a minute", async () => {
        const { db, sqls } = d1([], "D1_ERROR: no such column: by_year: SQLITE_ERROR")
        const pyramidReq: CellsRequest = { ...REQ, cells: ["89f"] }  // no such shard ⇒ empty pyramid read
        const empty = { res: 15, year_range: [2010, 2019], data_version: "test", source: "pyramid", labels: "nums", cells: [] }
        expect(await handleCellsRequest(bucket(), "cells", pyramidReq, db)).toEqual(empty)
        expect(await handleCellsRequest(bucket(), "cells", pyramidReq, db)).toEqual(empty)
        expect((await handleCellsRequest(bucket(), "cells", { ...pyramidReq, format: "cols", group: "year" }, db) as CellsColsYearResponse).source).toEqual("pyramid")
        expect(sqls).toEqual([`SELECT cellid, by_year FROM cells_s2_l15 WHERE (cellid BETWEEN '89e000004' AND '89ffffffc')`])
    })

    it("falls back to the pyramid on a NULL `by_year` (and retries D1 next time)", async () => {
        const { db, sqls } = d1([...ROWS, { cellid: "89c25744", by_year: null }])
        const pyramidReq: CellsRequest = { ...REQ, cells: ["89f"] }
        for (let i = 0; i < 2; i++) {
            expect((await handleCellsRequest(bucket(), "cells", pyramidReq, db) as CellsResponse).source).toEqual("pyramid")
        }
        expect(sqls.length).toEqual(2)
    })
})

/** Parity on real data: `by_year` strings built from the pyramid's own
 *  `(cell, year)` rows, served through the D1 path, must equal the pyramid
 *  path's answer cell-for-cell. Needs the local `data/cells/s2_pyramid`. */
const HAVE_PYRAMID = existsSync(`${PYRAMID_ROOT}/s2_pyramid/s2_l17/89d.parquet`)

describe.skipIf(!HAVE_PYRAMID)("D1 years path ≡ pyramid path (l17, Journal Square)", () => {
    beforeEach(() => { _resetManifestCache(); _resetFooterCache(); _resetByYearCache() })

    const JSQ: [number, number][] = [[-74.0680, 40.7370], [-74.0580, 40.7370], [-74.0580, 40.7300], [-74.0680, 40.7300]]
    const LEVEL = 17

    /** Encode pyramid rows into `by_year` (the Python encoder's grammar). */
    async function d1RowsFromPyramid(): Promise<Row[]> {
        const ranges = s2RangesForPolygon(JSQ, LEVEL).map(r => ({ lo: s2IdToToken(r.lo), hi: s2IdToToken(r.hi) }))
        const rows = await readParquetFromR2<Record<string, number> & { cellid: string; year: number }>(
            bucket(), `cells/s2_pyramid/s2_l${LEVEL}/89d.parquet`,
            { columns: ["cellid", "year", ...BY_YEAR_FIELDS], filter: { $or: ranges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) } },
        )
        const byCell = new Map<string, Array<{ year: number; enc: string }>>()
        for (const r of rows) {
            const vals = BY_YEAR_FIELDS.map(f => r[f] ? String(r[f]) : "").join(",").replace(/,+$/, "")
            let ys = byCell.get(r.cellid)
            if (!ys) { ys = []; byCell.set(r.cellid, ys) }
            ys.push({ year: r.year, enc: `${r.year - BY_YEAR_BASE}:${vals}` })
        }
        return [...byCell].map(([cellid, ys]) => ({
            cellid, by_year: ys.sort((a, b) => a.year - b.year).map(y => y.enc).join(";"),
        }))
    }

    const sortCells = (cells: CellOut[]) => [...cells].sort((a, b) => a.cellid < b.cellid ? -1 : 1)

    it("rows, several year ranges × severities", async () => {
        const { db } = d1(await d1RowsFromPyramid())
        // (years, severities) → cell count, so an accidentally-empty
        // comparison can't pass vacuously. Golden over the local pyramid.
        const sizes: Record<string, number> = {}
        for (const yearRange of [[2011, 2013], [2001, 2001], [2019, 2025]] as [number, number][]) {
            for (const severities of [undefined, new Set(["f"] as const), new Set(["i", "p"] as const)]) {
                const req: CellsRequest = { cells: ["89b", "89d"], res: LEVEL, yearRange, severities, clipPolygon: JSQ, labels: "nums" }
                const fromD1 = await handleCellsRequest(bucket(), "cells", req, db) as CellsResponse
                const fromPyramid = await handleCellsRequest(bucket(), "cells", req) as CellsResponse
                expect([fromD1.source, fromPyramid.source]).toEqual(["d1", "pyramid"])
                expect(sortCells(fromD1.cells)).toEqual(sortCells(fromPyramid.cells))
                sizes[`${yearRange.join("-")} ${severities ? [...severities].join("") : "fip"}`] = fromPyramid.cells.length
            }
        }
        expect(sizes).toMatchInlineSnapshot(`
          {
            "2001-2001 f": 0,
            "2001-2001 fip": 68,
            "2001-2001 ip": 68,
            "2011-2013 f": 0,
            "2011-2013 fip": 91,
            "2011-2013 ip": 91,
            "2019-2025 f": 2,
            "2019-2025 fip": 127,
            "2019-2025 ip": 127,
          }
        `)
    })

    it("format=cols&group=year", async () => {
        const { db } = d1(await d1RowsFromPyramid())
        const req: CellsRequest = { cells: ["89b", "89d"], res: LEVEL, yearRange: [2001, 2025], severities: new Set(["f", "i", "p"]), clipPolygon: JSQ, labels: "nums", format: "cols", group: "year" }
        const fromD1 = await handleCellsRequest(bucket(), "cells", req, db) as CellsColsYearResponse
        const fromPyramid = await handleCellsRequest(bucket(), "cells", req) as CellsColsYearResponse
        expect(fromPyramid.n_rows).toBeGreaterThan(0)
        expect({ ...fromD1, source: "pyramid" }).toEqual(fromPyramid)
    })
})
