/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import {
    type CellsColsResponse,
    type CellsRequest,
    type CellsResponse,
    type CellOut,
    COUNT_FIELDS,
    HttpError,
    decodeTokens,
    encodeTokens,
    handleCellsRequest,
    parseCellsRequest,
    toColumnar,
} from "./cells"
import { _resetManifestCache } from "./manifest"
import { _resetFooterCache } from "./parquet"

/** `format=cols` (heatmap C's lean fetch): parse, encode, and both query
 *  paths, plus the default (row) shape pinned so the opt-in mode can't drift
 *  it. */

const MANIFEST = { data_version: "test", year_range: [2001, 2025] }
const PYRAMID_ROOT = resolve(__dirname, "../../data/cells")

/** Fake R2 bucket: a synthetic manifest, plus pyramid files from the local
 *  DVX checkout (`data/cells/s2_pyramid`, see `s2-pruning.test.ts`). */
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

type D1Row = {
    cellid: string
    n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs: number
    n_killed: number; n_killed_ped: number
    fatal_years?: string | null
}

/** Fake D1 returning fixed rows (it ignores the WHERE clause), recording
 *  each SQL statement so tests can pin the selected columns. */
function d1(rows: D1Row[]) {
    const sqls: string[] = []
    const db = {
        prepare(sql: string) {
            sqls.push(sql)
            return { async all() { return { results: rows } } }
        },
    } as unknown as D1Database
    return { db, sqls }
}

const parse = (qs: string) => parseCellsRequest(new URL(`https://x/?${qs}`))

function parseErr(qs: string): { status: number; message: string } | undefined {
    try { parse(qs) } catch (e) {
        if (e instanceof HttpError) return { status: e.status, message: e.message }
        throw e
    }
    return undefined
}

describe("parseCellsRequest format/fields", () => {
    const BASE = "cells=89d&res=13"

    it("leaves both unset by default", () => {
        const r = parse(BASE)
        expect([r.format, r.fields]).toEqual([undefined, undefined])
    })

    it("parses format=cols with an ordered field list", () => {
        const r = parse(`${BASE}&format=cols&fields=n_pdo,n_fatal`)
        expect([r.format, r.fields]).toEqual(["cols", ["n_pdo", "n_fatal"]])
    })

    it("accepts an explicit format=rows", () => {
        expect(parse(`${BASE}&format=rows`).format).toBe("rows")
    })

    it.each([
        ["format=csv", "format must be one of rows|cols"],
        ["fields=n_fatal", "fields requires format=cols"],
        ["format=rows&fields=n_fatal", "fields requires format=cols"],
        ["format=cols&fields=", "fields must list ≥1 count column"],
        ["format=cols&fields=n_fatal,sld_name", "unknown field 'sld_name' (expected one of n_fatal|n_inj_ped|n_inj_other|n_pdo|n_vehs|n_killed|n_killed_ped)"],
        ["format=cols&fields=n_fatal,n_fatal", "fields must not repeat"],
    ])("rejects %s", (qs, message) => {
        expect(parseErr(`${BASE}&${qs}`)).toEqual({ status: 400, message })
    })
})

describe("token prefix-delta encoding", () => {
    const tokens = ["89c25c14", "89c25c1c", "89c25c2", "89c3"]
    const encoded = ["089c25c14", "7c", "62", "33"]

    it("encodes each token against its predecessor", () => {
        expect(encodeTokens(tokens)).toEqual(encoded)
    })

    it("round-trips", () => {
        expect(decodeTokens(encoded)).toEqual(tokens)
    })

    it("handles a token that is a prefix of its successor, and empty input", () => {
        expect(encodeTokens(["89c25c1", "89c25c14"])).toEqual(["089c25c1", "74"])
        expect(decodeTokens(["089c25c1", "74"])).toEqual(["89c25c1", "89c25c14"])
        expect([encodeTokens([]), decodeTokens([])]).toEqual([[], []])
    })

    it("rejects a duplicate 16-char token", () => {
        expect(() => encodeTokens(["89c25c1400000001", "89c25c1400000001"])).toThrow(
            "token 89c25c1400000001 shares 16 chars with its predecessor (duplicate?)",
        )
    })
})

describe("toColumnar", () => {
    const resp: CellsResponse = {
        res: 15, year_range: [2001, 2025], data_version: "v", source: "d1", labels: "nums",
        cells: [
            { cellid: "89c25734", n_fatal: 0, n_inj_ped: 1, n_inj_other: 2, n_pdo: 3, n_vehs: 4, n_killed: 0, n_killed_ped: 0 },
            { cellid: "89c2572c", n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 5, n_vehs: 9, n_killed: 2, n_killed_ped: 1, fatal_years: [2019] },
        ],
    }

    it("sorts by cellid and ships only the requested fields, in order", () => {
        expect(toColumnar(resp, ["n_pdo", "n_fatal"])).toEqual({
            res: 15, year_range: [2001, 2025], data_version: "v", source: "d1", labels: "nums",
            format: "cols", cellid_enc: "prefix-hex1", n: 2,
            cols: { cellid: ["089c2572c", "634"], n_pdo: [5, 3], n_fatal: [1, 0] },
        })
    })

    it("defaults to every count field", () => {
        expect(toColumnar(resp).cols).toEqual({
            cellid: ["089c2572c", "634"],
            n_fatal: [1, 0], n_inj_ped: [0, 1], n_inj_other: [0, 2], n_pdo: [5, 3], n_vehs: [9, 4],
            n_killed: [2, 0], n_killed_ped: [1, 0],
        })
    })
})

/** Decode a cols response back to row-shaped cells (no labels/fatal_years). */
function colsToRows(r: CellsColsResponse): CellOut[] {
    const ids = decodeTokens(r.cols.cellid)
    return ids.map((cellid, i) => {
        const c: Record<string, string | number> = { cellid }
        for (const f of COUNT_FIELDS) {
            const col = r.cols[f]
            if (col) c[f] = col[i]
        }
        return c as unknown as CellOut
    })
}

/** Project row cells to `cellid` + `fields`, sorted by cellid. */
function project(cells: CellOut[], fields: readonly string[]): CellOut[] {
    return [...cells]
        .sort((a, b) => a.cellid < b.cellid ? -1 : a.cellid > b.cellid ? 1 : 0)
        .map(c => Object.fromEntries([["cellid", c.cellid], ...fields.map(f => [f, c[f as keyof CellOut]])]) as CellOut)
}

const HEAT_FIELDS = ["n_fatal", "n_inj_ped", "n_inj_other", "n_pdo"] as const

describe("D1 path", () => {
    beforeEach(() => _resetManifestCache())

    // Unsorted, one all-zero-severity row (dropped by both modes).
    const ROWS: D1Row[] = [
        { cellid: "89c25734", n_fatal: 0, n_inj_ped: 1, n_inj_other: 2, n_pdo: 3, n_vehs: 4, n_killed: 0, n_killed_ped: 0, fatal_years: null },
        { cellid: "89c2572c", n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 5, n_vehs: 9, n_killed: 2, n_killed_ped: 1, fatal_years: "[2019]" },
        { cellid: "89c2573c", n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 1, n_killed: 0, n_killed_ped: 0, fatal_years: null },
    ]
    const REQ: CellsRequest = { cells: ["89d"], res: 15, labels: "nums" }
    const WHERE = "WHERE (cellid BETWEEN '89c000004' AND '89dfffffc')"

    it("default (rows) output is unchanged", async () => {
        const { db, sqls } = d1(ROWS)
        expect(await handleCellsRequest(bucket(), "cells", REQ, db)).toEqual({
            res: 15, year_range: [2001, 2025], data_version: "test", source: "d1", labels: "nums",
            cells: [
                { cellid: "89c25734", n_fatal: 0, n_inj_ped: 1, n_inj_other: 2, n_pdo: 3, n_vehs: 4, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c2572c", n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 5, n_vehs: 9, n_killed: 2, n_killed_ped: 1, fatal_years: [2019] },
            ],
        })
        expect(sqls).toEqual([
            `SELECT cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped, fatal_years FROM cells_s2_l15 ${WHERE}`,
        ])
    })

    it("format=cols serves the heat fields, sorted, without selecting fatal_years", async () => {
        const { db, sqls } = d1(ROWS)
        expect(await handleCellsRequest(bucket(), "cells", { ...REQ, format: "cols", fields: [...HEAT_FIELDS] }, db)).toEqual({
            res: 15, year_range: [2001, 2025], data_version: "test", source: "d1", labels: "nums",
            format: "cols", cellid_enc: "prefix-hex1", n: 2,
            cols: {
                cellid: ["089c2572c", "634"],
                n_fatal: [1, 0], n_inj_ped: [0, 1], n_inj_other: [0, 2], n_pdo: [5, 3],
            },
        })
        expect(sqls).toEqual([
            `SELECT cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped FROM cells_s2_l15 ${WHERE}`,
        ])
    })

    it("format=cols rejects labels=full / only", async () => {
        const { db } = d1(ROWS)
        for (const labels of ["full", "only"] as const) {
            await expect(handleCellsRequest(bucket(), "cells", { ...REQ, labels, format: "cols" }, db))
                .rejects.toMatchObject({ status: 400, message: "format=cols serves counts only (labels must be unset or nums)" })
        }
    })
})

/** Pyramid-path cases read the real l15/l17 files; skip without them. */
const HAVE_PYRAMID = existsSync(`${PYRAMID_ROOT}/s2_pyramid/s2_l15/89d.parquet`)
    && existsSync(`${PYRAMID_ROOT}/s2_pyramid/s2_l17/89d.parquet`)

describe.skipIf(!HAVE_PYRAMID)("pyramid path (year-filtered)", () => {
    beforeEach(() => { _resetManifestCache(); _resetFooterCache() })

    /** ~850×780 m box around Journal Square, Jersey City. */
    const JSQ: [number, number][] = [[-74.0680, 40.7370], [-74.0580, 40.7370], [-74.0580, 40.7300], [-74.0680, 40.7300]]
    const REQ: CellsRequest = { cells: ["89b", "89d"], res: 15, yearRange: [2015, 2022], clipPolygon: JSQ, labels: "nums" }

    it("default (rows) output is unchanged", async () => {
        // Golden produced by the pre-`format=cols` handler on the same query.
        expect(await handleCellsRequest(bucket(), "cells", REQ)).toEqual({
            res: 15, year_range: [2015, 2022], data_version: "test", source: "pyramid", labels: "nums",
            cells: [
                { cellid: "89c2572dc", n_fatal: 0, n_inj_ped: 28, n_inj_other: 45, n_pdo: 382, n_vehs: 868, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c2572e4", n_fatal: 0, n_inj_ped: 5, n_inj_other: 19, n_pdo: 59, n_vehs: 151, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c2572fc", n_fatal: 0, n_inj_ped: 4, n_inj_other: 19, n_pdo: 65, n_vehs: 160, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c257304", n_fatal: 1, n_inj_ped: 20, n_inj_other: 45, n_pdo: 272, n_vehs: 624, n_killed: 1, n_killed_ped: 0, fatal_years: [2015] },
                { cellid: "89c25730c", n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 9, n_vehs: 17, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c257314", n_fatal: 0, n_inj_ped: 11, n_inj_other: 22, n_pdo: 91, n_vehs: 223, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c25731c", n_fatal: 0, n_inj_ped: 6, n_inj_other: 15, n_pdo: 189, n_vehs: 409, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c257324", n_fatal: 0, n_inj_ped: 10, n_inj_other: 19, n_pdo: 129, n_vehs: 295, n_killed: 0, n_killed_ped: 0 },
                { cellid: "89c25733c", n_fatal: 0, n_inj_ped: 5, n_inj_other: 5, n_pdo: 34, n_vehs: 80, n_killed: 0, n_killed_ped: 0 },
            ],
        })
    })

    it("format=cols serves the same cells as parallel arrays", async () => {
        expect(await handleCellsRequest(bucket(), "cells", { ...REQ, format: "cols", fields: [...HEAT_FIELDS] })).toEqual({
            res: 15, year_range: [2015, 2022], data_version: "test", source: "pyramid", labels: "nums",
            format: "cols", cellid_enc: "prefix-hex1", n: 9,
            cols: {
                cellid: ["089c2572dc", "7e4", "7fc", "6304", "8c", "714", "8c", "724", "73c"],
                n_fatal: [0, 0, 0, 1, 0, 0, 0, 0, 0],
                n_inj_ped: [28, 5, 4, 20, 0, 11, 6, 10, 5],
                n_inj_other: [45, 19, 19, 45, 0, 22, 15, 19, 5],
                n_pdo: [382, 59, 65, 272, 9, 91, 189, 129, 34],
            },
        })
    })

    it("format=cols decodes to exactly the row response's cells (l17, a whole z13 tile)", async () => {
        // Jersey City z13 tile + heat C's 30% margin, as `fetchTileCells` sends it.
        const tile: [number, number][] = [[-74.1203, 40.7547], [-74.0149, 40.7547], [-74.0149, 40.6748], [-74.1203, 40.6748]]
        const req: CellsRequest = { cells: ["89b", "89d"], res: 17, yearRange: [2020, 2025], clipPolygon: tile, labels: "nums" }
        const rows = await handleCellsRequest(bucket(), "cells", req) as CellsResponse
        const cols = await handleCellsRequest(bucket(), "cells", { ...req, format: "cols" }) as CellsColsResponse
        expect(rows.cells.length).toBeGreaterThan(5_000)
        expect(cols.n).toBe(rows.cells.length)
        expect(colsToRows(cols)).toEqual(project(rows.cells, COUNT_FIELDS))
    }, 30_000)
})
