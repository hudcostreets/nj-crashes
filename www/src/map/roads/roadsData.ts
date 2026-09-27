/** Road data (specs/road-data-v4.md): parquets built by `njdot roads build`, read with DuckDB-WASM
 *  ranged reads. Each file is sorted for row-group pruning: `sri-hit` spatially (a viewport bbox
 *  reads a few groups), `sri-geom` / `crashes-by-sri` by `sri`, the rest by `entity` (= `slug`
 *  order, so a county's / muni's roads are contiguous). */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { runQuery } from "@/src/lib/DuckDbContext"
import { MAP_BASE_URL } from "@/src/map/config"

const { cos, PI, sqrt } = Math

/** Sibling of the map geometry dir (`…/njdot/map` → `…/njdot/roads`). */
export const ROADS_BASE_URL = MAP_BASE_URL.replace(/\/map\/?$/, "/roads")

export type RoadsFile =
    | "crashes-by-sri" | "crashes-by-entity" | "sri-geom" | "sri-hit" | "sri-hit-5" | "sri-hit-6"
    | "sris" | "road-entities" | "road-runs" | "road-summary" | "road-summary-monthly" | "road-ranks"
    | "road-search"

export function roadsUrl(file: RoadsFile): string {
    return new URL(`${ROADS_BASE_URL}/${file}.parquet`, window.location.origin).href
}

/** SRIs are `[0-9A-Z_]` (e.g. `00000001__`); reject anything else before interpolating into SQL. */
export function isSri(s: string): boolean {
    return /^[0-9A-Za-z_-]{1,32}$/.test(s)
}

/** Road slugs are `<county>/[<muni>/]<road>`, each segment `[a-z0-9-]` (specs/road-data-v4.md § Slugs). */
export function isRoadSlug(s: string): boolean {
    return /^[a-z0-9-]+(\/[a-z0-9-]+){1,2}$/.test(s)
}

function sriList(sris: string[]): string {
    return sris.filter(isSri).map(s => `'${s}'`).join(",")
}

/** An MP point (every 0.05 mi along the NJDOT Roadway Network): `name` = local street name (NG9-1-1),
 *  else the SLD name; `alias` = the top crash-reported road name nearby (where it differs), `subt` =
 *  road class (1 interstate … 7 local, 8 ramp). */
export type RoadPoint = {
    sri: string
    mp: number
    sld_name: string
    name: string
    subt: number
    entity: number
    alias: string | null
    lon: number
    lat: number
}

/** A road entity: same-named SRI runs joined across routes, within a county (see `njdot/road_net.py`).
 *  `entity` = rank of `slug` (not stable across builds; URLs use `slug`), `name` = the local
 *  (NG9-1-1) name, `route` = route designation(s) ("CR 501", "US 1 / US 9"), `aliases` = NG9-1-1
 *  local aliases then crash-reported names, " · "-joined. */
export type RoadEntity = {
    entity: number
    slug: string
    name: string
    route: string | null
    subt: number
    sris: string
    lon_min: number
    lat_min: number
    lon_max: number
    lat_max: number
    n_crashes: number
    n_fatal: number
    n_injury: number
    n_killed: number
    aliases: string | null
    cc: number | null
    /** NJDOT muni code when the road is within one muni (its slug has a muni segment), else null. */
    mc: number | null
    /** " · "-joined, most-covered first. */
    munis: string | null
    length_mi: number
}

/** Crash counts of one road per `(year[, month], severity)` (`road-summary[-monthly]`); only
 *  non-zero cells have a row. */
export type RoadSummaryRow = {
    year: number
    /** 1–12 (monthly file only). */
    month?: number
    severity: string
    n: number
    tk: number
    ti: number
}

/** A county's (`mc` = 0) or muni's top road (`road-ranks`): counts and miles *within that area*;
 *  `rank_*` null outside the area's top 50 for that metric. */
export type RoadRank = {
    cc: number
    mc: number
    entity: number
    slug: string
    name: string
    route: string | null
    subt: number
    n_crashes: number
    n_fatal: number
    n_killed: number
    length_mi: number
    /** Crashes per mile, all years; null for short (< 0.25 mi) or low-count (< 10) roads. */
    per_mi: number | null
    rank_crashes: number | null
    rank_fatal: number | null
    rank_killed: number | null
    rank_per_mi: number | null
}

export type RoadRun = { entity: number; sri: string; mp_lo: number; mp_end: number }

export type RoadInfo = {
    sri: string
    sld_name: string
    mp_min: number
    mp_max: number
    lon_min: number
    lat_min: number
    lon_max: number
    lat_max: number
    n_crashes: number
    n_fatal: number
    n_injury: number
    n_killed: number
}

export type RoadCrash = {
    entity?: number
    sri: string
    mp: number | null
    id: number | null
    year: number
    dt: number
    cc: number
    mc: number
    case: string
    severity: string
    tk: number | null
    ti: number | null
    pk: number | null
    pi: number | null
    tv: number | null
    road: string | null
    cross_street: string | null
    route: number | null
    lat: number | null
    lon: number | null
}

export type Bbox = [number, number, number, number]

/** Hit file for a zoom: wider views only get bigger roads (classes ≤ 5 / ≤ 6), which keeps a
 *  viewport's points small. Null below `HIT_TIERS`' lowest zoom. */
export const HIT_TIERS: { minZoom: number; file: RoadsFile }[] = [
    { minZoom: 13, file: "sri-hit" },
    { minZoom: 11, file: "sri-hit-6" },
    { minZoom: 9, file: "sri-hit-5" },
]

export function hitFileForZoom(zoom: number): RoadsFile | null {
    return HIT_TIERS.find(t => zoom >= t.minZoom)?.file ?? null
}

const POINT_COLS = "sri, mp, sld_name, name, subt, entity, alias, lon, lat"

export function fetchHitPoints(db: AsyncDuckDB, file: RoadsFile, [w, s, e, n]: Bbox): Promise<RoadPoint[]> {
    return runQuery<RoadPoint>(db, `
        SELECT ${POINT_COLS} FROM read_parquet('${roadsUrl(file)}')
        WHERE lon BETWEEN ${w} AND ${e} AND lat BETWEEN ${s} AND ${n}
    `)
}

export async function fetchEntity(db: AsyncDuckDB, entity: number): Promise<RoadEntity | null> {
    const rows = await runQuery<RoadEntity>(db, `SELECT * FROM read_parquet('${roadsUrl("road-entities")}') WHERE entity = ${entity | 0}`)
    return rows[0] ?? null
}

export async function fetchEntityBySlug(db: AsyncDuckDB, slug: string): Promise<RoadEntity | null> {
    if (!isRoadSlug(slug)) return null
    const rows = await runQuery<RoadEntity>(db, `SELECT * FROM read_parquet('${roadsUrl("road-entities")}') WHERE slug = '${slug}'`)
    return rows[0] ?? null
}

/** The road's crash counts per `(year, severity)`, or per `(year, month, severity)` with `monthly`. */
export function fetchEntitySummary(db: AsyncDuckDB, entity: number, monthly: boolean): Promise<RoadSummaryRow[]> {
    const file = monthly ? "road-summary-monthly" : "road-summary"
    return runQuery<RoadSummaryRow>(db, `
        SELECT year, ${monthly ? "month, " : ""}severity, n, tk, ti FROM read_parquet('${roadsUrl(file)}')
        WHERE entity = ${entity | 0}
    `)
}

/** Every ranked road of a county (`mc` = 0) or muni; callers sort / filter by a metric's rank. */
export function fetchRoadRanks(db: AsyncDuckDB, cc: number, mc: number): Promise<RoadRank[]> {
    return runQuery<RoadRank>(db, `SELECT * FROM read_parquet('${roadsUrl("road-ranks")}') WHERE cc = ${cc | 0} AND mc = ${mc | 0}`)
}

export function fetchEntityRuns(db: AsyncDuckDB, entity: number): Promise<RoadRun[]> {
    return runQuery<RoadRun>(db, `SELECT * FROM read_parquet('${roadsUrl("road-runs")}') WHERE entity = ${entity | 0} ORDER BY sri, mp_lo`)
}

/** The entity's points: `sri-geom` is sorted by `(sri, mp)`, so filtering on the entity's SRIs
 *  prunes to a few row groups before the `entity` filter. The `BETWEEN` does the pruning: DuckDB-
 *  WASM's DuckDB (v0.9) doesn't push `IN` lists into row-group stats. */
export function fetchEntityGeom(db: AsyncDuckDB, entity: number, sris: string[]): Promise<RoadPoint[]> {
    const ok = sris.filter(isSri).sort()
    if (!ok.length) return Promise.resolve([])
    return runQuery<RoadPoint>(db, `
        SELECT ${POINT_COLS} FROM read_parquet('${roadsUrl("sri-geom")}')
        WHERE sri BETWEEN '${ok[0]}' AND '${ok[ok.length - 1]}' AND sri IN (${sriList(ok)}) AND entity = ${entity | 0}
        ORDER BY sri, mp
    `)
}

/** `crashes-by-entity` is sorted by `(entity, sri, mp, dt, id)`, so the `entity` filter alone prunes
 *  to the road's row groups (no need to wait for its SRI list). */
export function entityCrashesSql(entity: number): string {
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${entity | 0} ORDER BY sri, mp, dt`
}

/** What the road views (table, map, plots) read; Export CSV fetches every column on demand. */
const VIEW_COLS = ["sri", "mp", "id", "year", "dt", "cc", "mc", "case", "severity", "tk", "ti", "cross_street", "lat", "lon"] as const
export type RoadCrashView = Pick<RoadCrash, typeof VIEW_COLS[number]>

export function fetchEntityCrashes(db: AsyncDuckDB, entity: number): Promise<RoadCrashView[]> {
    const cols = VIEW_COLS.filter(c => c !== "dt").map(c => `"${c}"`).join(", ")
    return runQuery<RoadCrashView>(db, `SELECT ${cols}, epoch_ms(dt) AS dt FROM (${entityCrashesSql(entity)})`)
}

export function fetchEntityCrashesFull(db: AsyncDuckDB, entity: number): Promise<RoadCrash[]> {
    return runQuery<RoadCrash>(db, `SELECT * EXCLUDE (dt), epoch_ms(dt) AS dt FROM (${entityCrashesSql(entity)})`)
}

/** The road entity a crash was matched to (null when it has no SRI match, or its point isn't on a
 *  road entity): `crashes-by-sri` is sorted by `sri`, so the SRI filter prunes to its row groups.
 *  Matches on `id`, or on the 4-field PK for rows without one (2024+). */
export async function fetchCrashEntity(
    db: AsyncDuckDB,
    crash: { id: number | null; sri: string; year: number; cc: number; mc: number; case: string },
): Promise<number | null> {
    if (!isSri(crash.sri)) return null
    const pk = `year = ${crash.year | 0} AND cc = ${crash.cc | 0} AND mc = ${crash.mc | 0} AND "case" = '${crash.case.replace(/'/g, "''")}'`
    const match = crash.id !== null ? `(id = ${crash.id | 0} OR (id IS NULL AND ${pk}))` : `(${pk})`
    const rows = await runQuery<{ entity: number }>(db, `
        SELECT entity FROM read_parquet('${roadsUrl("crashes-by-sri")}')
        WHERE sri = '${crash.sri}' AND ${match} LIMIT 1
    `)
    return rows[0]?.entity ?? null
}

export function fetchRoadGeom(db: AsyncDuckDB, sri: string): Promise<RoadPoint[]> {
    if (!isSri(sri)) return Promise.resolve([])
    return runQuery<RoadPoint>(db, `
        SELECT sri, mp, sld_name, lon, lat FROM read_parquet('${roadsUrl("sri-geom")}')
        WHERE sri = '${sri}' ORDER BY mp
    `)
}

export async function fetchRoadInfo(db: AsyncDuckDB, sri: string): Promise<RoadInfo | null> {
    if (!isSri(sri)) return null
    const rows = await runQuery<RoadInfo>(db, `SELECT * FROM read_parquet('${roadsUrl("sris")}') WHERE sri = '${sri}'`)
    return rows[0] ?? null
}

export function roadCrashesSql(sri: string): string {
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-sri")}') WHERE sri = '${sri}' ORDER BY mp, dt`
}

export function fetchRoadCrashes(db: AsyncDuckDB, sri: string): Promise<RoadCrash[]> {
    if (!isSri(sri)) return Promise.resolve([])
    return runQuery<RoadCrash>(db, `SELECT * EXCLUDE (dt), epoch_ms(dt) AS dt FROM (${roadCrashesSql(sri)})`)
}

/** Consecutive-MP segments of each route in `points` (same breaks as `roadPaths`). Hit-testing
 *  against segments rather than the MP points themselves: points are ~160 m apart on long routes,
 *  so a short side street's point can be nearer the cursor than any point of the road it's on. */
export type RoadSegment = { a: RoadPoint; b: RoadPoint }

export function roadSegments(points: RoadPoint[]): RoadSegment[] {
    const bySri = new Map<string, RoadPoint[]>()
    for (const p of points) {
        const list = bySri.get(p.sri)
        if (list) list.push(p)
        else bySri.set(p.sri, [p])
    }
    const out: RoadSegment[] = []
    for (const list of bySri.values()) {
        if (list.length === 1) { out.push({ a: list[0], b: list[0] }); continue }
        list.sort((x, y) => x.mp - y.mp)
        for (let i = 1; i < list.length; i++) {
            const a = list[i - 1], b = list[i]
            const dx = (b.lon - a.lon) * 111_320 * cos(a.lat * PI / 180)
            const dy = (b.lat - a.lat) * 110_540
            if (b.mp - a.mp <= 0.15 && sqrt(dx * dx + dy * dy) <= 400) out.push({ a, b })
        }
    }
    return out
}

/** The route nearest `[lon, lat]` (by distance to its segments) within `maxMeters`, as the segment's
 *  nearer endpoint (equirectangular; fine at these scales). */
export function nearestRoad(segments: RoadSegment[], [lon, lat]: [number, number], maxMeters: number): RoadPoint | null {
    const kx = 111_320 * cos(lat * PI / 180)
    const ky = 110_540
    let best: RoadPoint | null = null
    let bestD2 = maxMeters * maxMeters
    for (const { a, b } of segments) {
        const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * ky
        const bx = (b.lon - lon) * kx, by = (b.lat - lat) * ky
        const vx = bx - ax, vy = by - ay
        const len2 = vx * vx + vy * vy
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0
        const px = ax + t * vx, py = ay + t * vy
        const d2 = px * px + py * py
        if (d2 <= bestD2) { bestD2 = d2; best = t < 0.5 ? a : b }
    }
    return best
}

/** Split a route's points (sorted by MP) into drawable paths, breaking at MP gaps or long jumps
 *  (routes can be discontinuous, and a viewport's hit points can skip out-of-view stretches). */
export function roadPaths(points: RoadPoint[]): [number, number][][] {
    const pts = [...points].sort((a, b) => (a.sri < b.sri ? -1 : a.sri > b.sri ? 1 : a.mp - b.mp))
    const out: [number, number][][] = []
    let cur: [number, number][] = []
    let prev: RoadPoint | null = null
    for (const p of pts) {
        if (prev && prev.sri !== p.sri) {
            if (cur.length > 1) out.push(cur)
            cur = []
        } else if (prev) {
            const dx = (p.lon - prev.lon) * 111_320 * cos(p.lat * PI / 180)
            const dy = (p.lat - prev.lat) * 110_540
            if (p.mp - prev.mp > 0.15 || sqrt(dx * dx + dy * dy) > 400) {
                if (cur.length > 1) out.push(cur)
                cur = []
            }
        }
        cur.push([p.lon, p.lat])
        prev = p
    }
    if (cur.length > 1) out.push(cur)
    return out
}
