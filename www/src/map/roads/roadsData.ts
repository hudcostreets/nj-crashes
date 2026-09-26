/** Road-selection data (specs/road-name-normalization-and-search.md Layer 4b, phase 1): parquets
 *  built by `njdot roads build`, read with DuckDB-WASM ranged reads. Each file is sorted for
 *  row-group pruning: `sri-hit` spatially (a viewport bbox reads a few groups), the rest by `sri`. */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { runQuery } from "@/src/lib/DuckDbContext"
import { MAP_BASE_URL } from "@/src/map/config"

const { cos, PI, sqrt } = Math

/** Sibling of the map geometry dir (`…/njdot/map` → `…/njdot/roads`). */
export const ROADS_BASE_URL = MAP_BASE_URL.replace(/\/map\/?$/, "/roads")

export function roadsUrl(file: "crashes-by-sri" | "sri-geom" | "sri-hit" | "sris"): string {
    return new URL(`${ROADS_BASE_URL}/${file}.parquet`, window.location.origin).href
}

/** SRIs are `[0-9A-Z_]` (e.g. `00000001__`); reject anything else before interpolating into SQL. */
export function isSri(s: string): boolean {
    return /^[0-9A-Za-z_-]{1,32}$/.test(s)
}

export type RoadPoint = { sri: string; mp: number; sld_name: string; lon: number; lat: number }

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

export function fetchHitPoints(db: AsyncDuckDB, [w, s, e, n]: Bbox): Promise<RoadPoint[]> {
    return runQuery<RoadPoint>(db, `
        SELECT sri, mp, sld_name, lon, lat FROM read_parquet('${roadsUrl("sri-hit")}')
        WHERE lon BETWEEN ${w} AND ${e} AND lat BETWEEN ${s} AND ${n}
    `)
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
    const pts = [...points].sort((a, b) => a.mp - b.mp)
    const out: [number, number][][] = []
    let cur: [number, number][] = []
    let prev: RoadPoint | null = null
    for (const p of pts) {
        if (prev) {
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
