/** Road search by name (omnibar), over `road-search.parquet`: a word index of every road's name,
 *  route designations and aliases, one row per `(token, name)` (specs/road-data-v4.md § road-search). */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { asyncBufferFromUrl, parquetMetadataAsync } from "hyparquet"
import { runQuery } from "@/src/lib/DuckDbContext"
import { roadsUrl, type Bbox } from "./roadsData"

/** Canonical (long) word → its abbreviations. Index tokens are canonical, and query words are
 *  mapped the same way. Mirrors `SYNONYMS` in `njdot/road_outputs.py` (pinned by a test). */
export const SYNONYMS: Record<string, string[]> = {
    north: ["n"], south: ["s"], east: ["e"], west: ["w"],
    avenue: ["ave", "av"], street: ["st"], saint: ["st"], boulevard: ["blvd"], road: ["rd"],
    drive: ["dr"], highway: ["hwy"], parkway: ["pkwy"], turnpike: ["tpke", "tpk"],
    place: ["pl"], lane: ["ln"], court: ["ct"], terrace: ["ter"], expressway: ["expy"],
    route: ["rt", "rte"], county: ["co"], mount: ["mt"], fort: ["ft"], circle: ["cir"],
}
const CANON = new Map<string, string>()
for (const [w, abbrs] of Object.entries(SYNONYMS)) {
    for (const a of abbrs) if (a !== "st") CANON.set(a, w)
}

/** Lower-cased ASCII alphanumeric words (NFKD-folded, like the index's): everything else (quotes,
 *  `%`, regex syntax, …) is a separator, so words are safe to splice into SQL string literals. */
export function queryTokens(query: string): string[] {
    return query.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** A query word, with the index tokens it matches: `exact` (its canonical forms; "st" is both
 *  "street" and "saint"), and — for the word being typed — any token starting with `prefix`. */
export type QueryWord = { word: string; exact: string[]; prefix: string | null }

/** `query`'s words, canonicalized. The last word is still being typed (a prefix) unless the query
 *  ends in a separator. */
export function queryWords(query: string): QueryWord[] {
    const ws = queryTokens(query)
    const typing = /[a-z0-9]$/i.test(query.normalize("NFKD"))
    return ws.map((w, i) => ({
        word: w,
        exact: w === "st" ? ["street", "saint"] : [CANON.get(w) ?? w],
        prefix: typing && i === ws.length - 1 ? w : null,
    }))
}

function matchesWord(q: QueryWord, words: string[]): boolean {
    return words.some(w => q.exact.includes(w) || (q.prefix !== null && w.startsWith(q.prefix)))
}

/** Which word to fetch from the index: the longest whose tokens aren't capped (`capped`: tokens
 *  with more rows than the index keeps; a rarer word narrows better). Null when there's nothing
 *  useful to fetch (a lone 1-character prefix would span several row groups). */
export function pickWord(words: QueryWord[], capped: Set<string>): QueryWord | null {
    const usable = words.filter(q => q.prefix === null || q.prefix.length > 1 || q.exact[0] !== q.word)
    if (!usable.length) return null
    const score = (q: QueryWord) => (q.exact.every(t => capped.has(t)) ? 0 : 1) * 1000 + q.word.length
    return usable.reduce((best, q) => (score(q) > score(best) ? q : best))
}

/** The prefix's exclusive upper bound (`kenn` → `keno`). */
export function prefixEnd(p: string): string {
    return p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)
}

/** `WHERE` clauses fetching `q`'s rows, one query each: its exact canonical tokens, plus a
 *  prefix range when it's being typed (tokens are `[a-z0-9]`, so they're safe to inline). Each is
 *  a single `=` or range, which DuckDB-WASM's DuckDB (v0.9) pushes into the row-group stats; it
 *  doesn't push `OR` / `IN`, and scans the whole file for them. */
export function wordFilters(q: QueryWord): string[] {
    const prefix = q.prefix !== null && q.prefix.length > 1 ? q.prefix : null
    const exact = q.exact.filter(t => prefix === null || !t.startsWith(prefix))
    return [
        ...exact.map(t => `token = '${t}'`),
        ...(prefix !== null ? [`token >= '${prefix}' AND token < '${prefixEnd(prefix)}'`] : []),
    ]
}

/** One `road-search.parquet` row (without `token`). */
export type RoadSearchRow = {
    entity: number
    slug: string
    name: string
    /** The name this row came from; null when it's the road's own `name`. */
    matched: string | null
    kind: "primary" | "route" | "alias"
    /** The matched name's canonical words, space-joined. */
    words: string
    subt: number
    n_crashes: number
    place: string | null
    lon: number
    lat: number
    /** bbox offsets from `lon` / `lat`, in `BBOX_UNIT`° */
    dx0: number
    dy0: number
    dx1: number
    dy1: number
}

export const BBOX_UNIT = 1e-5

export function hitBbox(r: Pick<RoadSearchRow, "lon" | "lat" | "dx0" | "dy0" | "dx1" | "dy1">): Bbox {
    return [r.lon + r.dx0 * BBOX_UNIT, r.lat + r.dy0 * BBOX_UNIT, r.lon + r.dx1 * BBOX_UNIT, r.lat + r.dy1 * BBOX_UNIT]
}

const KIND_ORDER = { primary: 0, route: 1, alias: 2 }

/** Rows where every query word matches some word of the row's name; one per road (its primary
 *  name when that matched, else a route, else an alias), most crashes first. */
export function filterHits(rows: RoadSearchRow[], words: QueryWord[], limit: number): RoadSearchRow[] {
    const best = new Map<number, RoadSearchRow>()
    for (const r of rows) {
        const ws = r.words.split(" ")
        if (!words.every(q => matchesWord(q, ws))) continue
        const cur = best.get(r.entity)
        if (!cur || KIND_ORDER[r.kind] < KIND_ORDER[cur.kind]) best.set(r.entity, r)
    }
    return [...best.values()]
        .sort((a, b) => b.n_crashes - a.n_crashes || a.entity - b.entity)
        .slice(0, limit)
}

const SEARCH_COLS = "entity, slug, name, matched, kind, words, subt, n_crashes, place, lon, lat, dx0, dy0, dx1, dy1"
let cappedTokens: Promise<Set<string>> | null = null

/** The index's capped tokens (key-value metadata `capped_tokens`: `{token: full count}`), read once
 *  per session. Via hyparquet: DuckDB-WASM's DuckDB (v0.9) has no `parquet_kv_metadata`. The
 *  footer is ~100 KB, so one 128 KB tail read covers it. */
function fetchCapped(): Promise<Set<string>> {
    if (!cappedTokens) {
        cappedTokens = asyncBufferFromUrl({ url: roadsUrl("road-search") })
            .then(buf => parquetMetadataAsync(buf, { initialFetchSize: 1 << 17 }))
            .then(md => {
                const kv = md.key_value_metadata?.find(({ key }) => key === "capped_tokens")
                return new Set(Object.keys(kv?.value ? JSON.parse(kv.value) as Record<string, number> : {}))
            })
        cappedTokens.catch(() => { cappedTokens = null })
    }
    return cappedTokens
}

/** Roads matching `query`, most crashes first (specs/road-data-v4.md's recipe): fetch one word's
 *  rows (a token-range read of 1–2 row groups), filter the rest client-side. The one place that
 *  knows where road-search data lives. */
export async function searchRoads(db: AsyncDuckDB, query: string, limit: number): Promise<RoadSearchRow[]> {
    const words = queryWords(query)
    const q = pickWord(words, await fetchCapped())
    if (!q) return []
    const rows = await Promise.all(wordFilters(q).map(where => runQuery<RoadSearchRow>(db, `
        SELECT ${SEARCH_COLS} FROM read_parquet('${roadsUrl("road-search")}') WHERE ${where}
    `)))
    return filterHits(rows.flat(), words, limit)
}

export type RoadHitLabel = {
    label: string
    description: string
}

/** Omnibar label for a search hit: the road's name, the route / alias that matched (when the
 *  name itself didn't), its place, and its crash count. */
export function formatRoadHit(hit: Pick<RoadSearchRow, "name" | "matched" | "kind" | "place" | "n_crashes">): RoadHitLabel {
    const n = hit.n_crashes
    const parts = [
        ...(hit.matched ? [`${hit.kind === "route" ? "on" : "aka"} ${hit.matched}`] : []),
        ...(hit.place ? [hit.place] : []),
        `${n.toLocaleString("en-US")} crash${n === 1 ? "" : "es"}`,
    ]
    return { label: hit.name, description: parts.join(" · ") }
}
