/** Parity: each road read through `@/src/lib/pq` returns the rows the DuckDB SQL it replaced did, on
 *  the real road files (specs/off-duckdb-wasm.md § Parity). Needs `public/njdot/roads/*.parquet`
 *  (symlink / `dvx pull`) and the `duckdb` CLI; skipped without them. Rows are compared as
 *  multisets (ties in the SQL's `ORDER BY` are unordered), and the pq order is checked separately. */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { openParquet, sortRows, type SortKey } from "@/src/lib/pq"
import { duckRows, fileRangeFetch, haveDuckdb, normFloats as norm, type Row } from "@/src/lib/pq/nodeFetch"
import {
    fetchBlocks, fetchCorridor, fetchCorridorSummary, fetchCrashEntity, fetchEntity, fetchEntityBySlug, fetchEntityCrashes,
    fetchEntityCrashesFull, fetchEntityGeom, fetchEntityNames, fetchEntitySummary, fetchEntityXs, fetchHitPoints,
    fetchRoadRanks, fetchSpanCrashes, roadsUrl, spanPredicate, type RoadsFile,
} from "./roadsData"
import { filterHits, pickWord, queryWords, searchRoads, type RoadSearchRow } from "./roadSearch"
import type { SpanSel } from "./roadScope"

const ROADS = join(__dirname, "../../../public/njdot/roads")
const enabled = haveDuckdb && existsSync(join(ROADS, "crashes-by-entity.parquet"))

const FILES: RoadsFile[] = [
    "crashes-by-sri", "crashes-by-entity", "crashes-by-entity-xs", "sri-geom", "sri-hit", "road-entities",
    "road-summary", "road-summary-monthly", "road-ranks", "road-search", "road-blocks", "road-corridors",
    "road-corridor-summary-monthly",
]

const local = (file: RoadsFile) => `'${join(ROADS, `${file}.parquet`)}'`
/** `read_parquet('<url>')` → the local file. */
function localize(sql: string): string {
    return FILES.reduce((s, f) => s.replaceAll(`'${roadsUrl(f)}'`, local(f)), sql)
}

/** DuckDB CLI rows of `sql` over the local files. */
function duck(sql: string): Row[] {
    return duckRows(localize(sql))
}

const key = (r: Row) => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]))
const bag = (rows: Row[]) => rows.map(key).sort()

/** pq rows (normalized like `duck`) equal the SQL's as a multiset; returns the count. */
function same(pq: object[], sql: string): number {
    const want = duck(sql)
    expect(bag(norm(pq as Row[]))).toEqual(bag(want))
    return want.length
}

function sortedBy<T>(rows: T[], keys: SortKey<T>[]) {
    expect(rows).toEqual(sortRows(rows, keys))
}

const VIEW = "COLUMNS('^(sri|mp|id|year|cc|mc|case|severity|tk|ti|cross_street|lat|lon|loc_source|chain|chain_lo|chain_hi|node|entity|block|corridor_only)$'), epoch_ms(dt) AS dt"
const SUMMARY = "severity|n|tk|ti|n_unplaced|n_node|n_xs|tk_xs|ti_xs|n_corridor_only"

describe.skipIf(!enabled)("road reads: pq vs DuckDB", () => {
    const JFK = 42039
    const CORRIDOR = 1810
    beforeAll(async () => {
        for (const f of FILES) await openParquet(roadsUrl(f), { fetch: fileRangeFetch(join(ROADS, `${f}.parquet`)) })
    })

    it("road-entities: by slug, by id", async () => {
        const e = await fetchEntityBySlug("hudson/j-f-kennedy-boulevard")
        expect(e?.entity).toBe(JFK)
        expect(same([e!], `SELECT * FROM read_parquet('${roadsUrl("road-entities")}') WHERE slug = 'hudson/j-f-kennedy-boulevard'`)).toBe(1)
        expect(same([(await fetchEntity(JFK))!], `SELECT * FROM read_parquet('${roadsUrl("road-entities")}') WHERE entity = ${JFK}`)).toBe(1)
    })

    it("road-summary[-monthly]", async () => {
        const n = same(await fetchEntitySummary(JFK, false), `SELECT COLUMNS('^(year|${SUMMARY})$') FROM read_parquet('${roadsUrl("road-summary")}') WHERE entity = ${JFK}`)
        const m = same(await fetchEntitySummary(JFK, true), `SELECT COLUMNS('^(year|month|${SUMMARY})$') FROM read_parquet('${roadsUrl("road-summary-monthly")}') WHERE entity = ${JFK}`)
        expect([n > 50, m > n]).toEqual([true, true])
    })

    it("corridor, its summary", async () => {
        expect(same([(await fetchCorridor(CORRIDOR))!], `SELECT * FROM read_parquet('${roadsUrl("road-corridors")}') WHERE corridor = ${CORRIDOR}`)).toBe(1)
        expect(same(await fetchCorridorSummary(CORRIDOR), `SELECT COLUMNS('^(year|month|${SUMMARY})$') FROM read_parquet('${roadsUrl("road-corridor-summary-monthly")}') WHERE corridor = ${CORRIDOR}`) > 10).toBe(true)
    })

    it("road-ranks (county, muni)", async () => {
        const county = same(await fetchRoadRanks(9, 0), `SELECT * FROM read_parquet('${roadsUrl("road-ranks")}') WHERE cc = 9 AND mc = 0`)
        const muni = same(await fetchRoadRanks(9, 6), `SELECT * FROM read_parquet('${roadsUrl("road-ranks")}') WHERE cc = 9 AND mc = 6`)
        expect([county > 50, muni > 20]).toEqual([true, true])
    })

    it("sri-geom (ordered by sri, mp)", async () => {
        const rows = await fetchEntityGeom(JFK)
        sortedBy(rows, ["sri", "mp"])
        expect(same(rows, `SELECT COLUMNS('^(sri|mp|sld_name|name|subt|entity|alias|lon|lat|chain)$') FROM read_parquet('${roadsUrl("sri-geom")}') WHERE entity = ${JFK}`) > 100).toBe(true)
    })

    it("sri-hit bbox", async () => {
        const bbox: [number, number, number, number] = [-74.07, 40.72, -74.05, 40.74]
        const rows = await fetchHitPoints("sri-hit", bbox)
        expect(same(rows, `SELECT sri, mp, sld_name, name, subt, entity, alias, lon, lat FROM read_parquet('${roadsUrl("sri-hit")}') WHERE lon BETWEEN -74.07 AND -74.05 AND lat BETWEEN 40.72 AND 40.74`) > 100).toBe(true)
    })

    it("crashes-by-entity: view columns and full rows, chain order", async () => {
        const rows = await fetchEntityCrashes(JFK, true)
        sortedBy(rows, ["chain", "dt"])
        const n = same(rows, `SELECT ${VIEW} FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${JFK}`)
        expect(n > 30000).toBe(true)  // JFK Blvd; exact count moves with each roads rebuild
        expect(same(await fetchEntityCrashesFull(JFK, true), `SELECT * EXCLUDE (dt), epoch_ms(dt) AS dt FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${JFK}`)).toBe(n)
    })

    it("crashes-by-entity-xs: whole road, block span, chain span", async () => {
        const blocks = await fetchBlocks(JFK)
        expect(same(blocks, `SELECT * FROM read_parquet('${roadsUrl("road-blocks")}') WHERE entity = ${JFK}`)).toBe(blocks.length)
        sortedBy(blocks, ["block"])
        const xs = (sel?: SpanSel) => `SELECT ${VIEW}, own_entity FROM read_parquet('${roadsUrl("crashes-by-entity-xs")}') WHERE entity = ${JFK}${sel ? ` AND ${spanPredicate(sel)}` : ""}`
        const bsel: SpanSel = { span: { lo: 6, hi: 7 }, hiClosed: false, blocks: [30, 36] }
        const csel: SpanSel = { span: { lo: 6, hi: 7 }, hiClosed: false, blocks: null }
        const whole = await fetchEntityXs(JFK)
        sortedBy(whole, ["chain", "dt"])
        const counts = [same(whole, xs()), same(await fetchEntityXs(JFK, bsel), xs(bsel)), same(await fetchEntityXs(JFK, csel), xs(csel))]
        expect(counts.every(c => c > 0)).toBe(true)
    })

    it("span crashes: one $or read = the two UNION ALL scans", async () => {
        const e = JFK
        const sql = (sel: SpanSel, v51: boolean) => `SELECT ${VIEW} FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${e} AND ${spanPredicate(sel)}
            UNION ALL SELECT ${VIEW} FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${e} AND chain IS NULL AND chain_lo <= ${sel.span.hi} AND chain_hi >= ${sel.span.lo}${v51 ? " AND NOT coalesce(corridor_only, false)" : ""}`
        const sels: SpanSel[] = [
            { span: { lo: 6, hi: 7 }, hiClosed: false, blocks: [30, 36] },
            { span: { lo: 6, hi: 7 }, hiClosed: false, blocks: null },
            { span: { lo: 14, hi: 14.71004 }, hiClosed: true, blocks: null },
        ]
        for (const sel of sels) {
            for (const v51 of [true, false]) {
                const rows = await fetchSpanCrashes(e, sel, v51)
                sortedBy(rows, ["chain", "dt"])
                expect(same(rows, sql(sel, v51)) > 0).toBe(true)
            }
        }
    })

    it("entity names: one IN read = the per-cluster BETWEEN scans", async () => {
        const ids = [42015, 41998, 41999, 42036, 43187, 42037, 1, 30000]
        const names = await fetchEntityNames(ids)
        const want = duck(`SELECT entity, name FROM read_parquet('${roadsUrl("road-entities")}') WHERE entity IN (${ids.join(", ")})`)
        expect([...names.entries()].sort((a, b) => a[0] - b[0])).toEqual(want.map(r => [r.entity, r.name]).sort((a, b) => (a[0] as number) - (b[0] as number)))
        expect(names.size).toBe(8)
    })

    it("crash → entity (by id; by 4-field PK for id-less rows)", async () => {
        const pick = (year: number) => duck(`SELECT sri, id, year, cc, mc, "case" FROM read_parquet('${roadsUrl("crashes-by-sri")}') WHERE entity = ${JFK} AND year = ${year} ORDER BY dt LIMIT 1`)[0]
        for (const c of [pick(2021), pick(2024)]) {
            const crash = { id: c.id as number | null, sri: c.sri as string, year: c.year as number, cc: c.cc as number, mc: c.mc as number, case: c.case as string }
            const pk = `year = ${crash.year} AND cc = ${crash.cc} AND mc = ${crash.mc} AND "case" = '${crash.case.replace(/'/g, "''")}'`
            const match = crash.id !== null ? `(id = ${crash.id} OR (id IS NULL AND ${pk}))` : `(${pk})`
            const want = duck(`SELECT entity FROM read_parquet('${roadsUrl("crashes-by-sri")}') WHERE sri = '${crash.sri}' AND ${match} LIMIT 1`)
            expect(await fetchCrashEntity(crash)).toBe(want[0].entity)
        }
    })

    it("road search: one read = the per-token scans", async () => {
        for (const q of ["kennedy blvd", "west side av", "st ", "hudson co"]) {
            const words = queryWords(q)
            const capped = new Set(Object.keys(JSON.parse(duck(`SELECT decode(value) AS v FROM parquet_kv_metadata(${local("road-search")}) WHERE decode(key) = 'capped_tokens'`)[0].v as string)))
            const w = pickWord(words, capped)!
            const prefix = w.prefix !== null && w.prefix.length > 1 ? w.prefix : null
            const exact = w.exact.filter(t => prefix === null || !t.startsWith(prefix))
            const wheres = [
                ...exact.map(t => `token = '${t}'`),
                ...(prefix !== null ? [`token >= '${prefix}' AND token < '${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}'`] : []),
            ]
            const cols = "entity, slug, name, matched, kind, words, subt, n_crashes, place, lon, lat, dx0, dy0, dx1, dy1"
            const old = wheres.flatMap(where => duck(`SELECT ${cols} FROM read_parquet('${roadsUrl("road-search")}') WHERE ${where}`)) as RoadSearchRow[]
            const hits = await searchRoads(q, 20)
            expect(norm(hits as unknown as Row[])).toEqual(filterHits(old, words, 20))
            expect(hits.length > 0).toBe(true)
        }
    })
})
