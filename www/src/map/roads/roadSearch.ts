/** Road search by name (omnibar): token matching over each road entity's name, route and aliases,
 *  ranked by crash count. */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { runQuery } from "@/src/lib/DuckDbContext"
import type { CC2MC2MN } from "@/src/county"
import { roadsUrl } from "./roadsData"

export type RoadHit = {
    entity: number
    name: string
    route: string | null
    subt: number
    aliases: string | null
    sris: string
    n_crashes: number
}

/** Interchangeable street-name words (NJDOT names mix "W Side Ave", "WEST SIDE AVE", …). */
const SYNONYMS: string[][] = [
    ["north", "n"], ["south", "s"], ["east", "e"], ["west", "w"],
    ["avenue", "ave", "av"], ["street", "st"], ["saint", "st"], ["boulevard", "blvd"], ["road", "rd"],
    ["drive", "dr"], ["highway", "hwy"], ["parkway", "pkwy"], ["turnpike", "tpke", "tpk"],
    ["place", "pl"], ["lane", "ln"], ["court", "ct"], ["terrace", "ter"], ["expressway", "expy"],
    ["route", "rt", "rte"], ["county", "co"], ["mount", "mt"], ["fort", "ft"], ["circle", "cir"],
]
const ALTS = new Map<string, Set<string>>()
for (const group of SYNONYMS) {
    for (const w of group) {
        const alts = ALTS.get(w) ?? new Set<string>()
        for (const a of group) if (a !== w) alts.add(a)
        ALTS.set(w, alts)
    }
}

/** Lower-cased alphanumeric query tokens; everything else (quotes, `%`, regex syntax, …) is a
 *  separator, so tokens are safe to splice into a regex. */
export function queryTokens(query: string): string[] {
    return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** One regex per token, all of which must match (lower-cased) road text: the typed token as a
 *  word prefix, or any of its synonyms as a whole word. */
export function tokenPatterns(query: string): string[] {
    return queryTokens(query).map(t => {
        const alts = [...(ALTS.get(t) ?? [])]
        return alts.length
            ? `(^|[^a-z0-9])(${t}|(${alts.join("|")})([^a-z0-9]|$))`
            : `(^|[^a-z0-9])${t}`
    })
}

export function matchesAll(text: string, patterns: string[]): boolean {
    const s = text.toLowerCase()
    return patterns.every(p => new RegExp(p).test(s))
}

const SEARCH_TABLE = "road_search"
const tables = new WeakMap<AsyncDuckDB, Promise<unknown>>()

/** The search columns of `road-entities.parquet` (~2 MB of its ~6.5 MB), loaded into a DuckDB
 *  table on the first search, so later keystrokes don't re-read the parquet. */
function searchTable(db: AsyncDuckDB): Promise<unknown> {
    let p = tables.get(db)
    if (!p) {
        p = runQuery(db, `
            CREATE OR REPLACE TABLE ${SEARCH_TABLE} AS
            SELECT entity, name, route, subt, aliases, sris, n_crashes,
                   lower(concat_ws(' · ', name, route, aliases)) AS hay
            FROM read_parquet('${roadsUrl("road-entities")}')
        `)
        p.catch(() => tables.delete(db))
        tables.set(db, p)
    }
    return p
}

/** Roads matching `query` (see `tokenPatterns`), most crashes first. The one place that knows
 *  where road-search data lives. */
export async function searchRoads(db: AsyncDuckDB, query: string, limit: number): Promise<RoadHit[]> {
    const patterns = tokenPatterns(query)
    if (!patterns.length) return []
    await searchTable(db)
    return runQuery<RoadHit>(db, `
        SELECT entity, name, route, subt, aliases, sris, n_crashes FROM ${SEARCH_TABLE}
        WHERE ${patterns.map(() => "regexp_matches(hay, ?)").join(" AND ")}
        ORDER BY n_crashes DESC, entity
        LIMIT ${limit | 0}
    `, patterns)
}

/** Where a road is, from its SRIs: municipal-road SRIs are `CCMM####` (county, NJDOT muni code),
 *  county roads `CC00####`, and state / interstate / 500-series routes `0000####` (statewide; no
 *  location). E.g. "Jersey City, Hudson", "Hudson County", "Essex / Hudson". */
export function roadLocation(sris: string, cc2mc2mn: CC2MC2MN | null): string | null {
    const ccs = new Set<number>()
    const munis = new Set<string>()
    for (const sri of sris.split(",")) {
        const m = /^(\d{2})(\d{2})/.exec(sri.trim())
        if (!m) return null
        const cc = Number(m[1]), mc = Number(m[2])
        if (cc === 0) return null
        ccs.add(cc)
        munis.add(`${cc}-${mc}`)
    }
    if (!ccs.size || !cc2mc2mn) return null
    const counties = [...ccs].sort((a, b) => a - b).map(cc => cc2mc2mn[cc]?.cn)
    if (counties.some(cn => !cn)) return null
    if (ccs.size > 1) return ccs.size <= 2 ? counties.join(" / ") : `${ccs.size} counties`
    const [cc] = ccs
    const county = counties[0]!
    const mcs = [...munis].map(k => Number(k.split("-")[1])).sort((a, b) => a - b)
    if (mcs.includes(0)) return `${county} County`
    const names = mcs.map(mc => cc2mc2mn[cc].mc2mn[mc])
    if (names.some(n => !n) || names.length > 2) return `${county} County`
    return `${names.join(" / ")}, ${county}`
}

export type RoadHitLabel = {
    label: string
    /** The alias (or route name) that matched, when the name itself didn't. */
    alias: string | null
    description: string
}

/** Omnibar label for a search hit: the road's name, the alias that matched (when the name
 *  didn't), its location, and its crash count. */
export function formatRoadHit(hit: RoadHit, query: string, cc2mc2mn: CC2MC2MN | null): RoadHitLabel {
    const patterns = tokenPatterns(query)
    const others = [hit.route, ...(hit.aliases?.split(" · ") ?? [])].filter((s): s is string => !!s && s !== hit.name)
    const alias = matchesAll(hit.name, patterns) ? null : others.find(s => matchesAll(s, patterns)) ?? null
    const n = hit.n_crashes
    const parts = [
        ...(alias ? [`aka ${alias}`] : []),
        ...[roadLocation(hit.sris, cc2mc2mn)].filter((s): s is string => !!s),
        `${n.toLocaleString("en-US")} crash${n === 1 ? "" : "es"}`,
    ]
    return { label: hit.name, alias, description: parts.join(" · ") }
}
