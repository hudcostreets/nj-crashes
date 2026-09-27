/** Road data (specs/road-data-v4.md): parquets built by `njdot roads build`, read with DuckDB-WASM
 *  ranged reads. Each file is sorted for row-group pruning: `sri-hit` spatially (a viewport bbox
 *  reads a few groups), `crashes-by-sri` / `sris` by `sri`, the rest (incl. `sri-geom`) by `entity`
 *  (= `slug` order, so a county's / muni's roads are contiguous). */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import { runQuery } from "@/src/lib/DuckDbContext"
import { MAP_BASE_URL } from "@/src/map/config"
import { spanBounds, type Span } from "./roadScope"

const { cos, PI, sqrt } = Math

/** Sibling of the map geometry dir (`…/njdot/map` → `…/njdot/roads`). */
export const ROADS_BASE_URL = MAP_BASE_URL.replace(/\/map\/?$/, "/roads")

export type RoadsFile =
    | "crashes-by-sri" | "crashes-by-entity" | "sri-geom" | "sri-hit" | "sri-hit-5" | "sri-hit-6"
    | "sris" | "road-entities" | "road-runs" | "road-summary" | "road-summary-monthly" | "road-ranks"
    | "road-search" | "crashes-by-entity-xs" | "road-blocks" | "road-node-entities" | "road-corridors"
    | "road-corridor-summary"

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
    // v5 (specs/road-model-v5.md); absent in v4 builds.
    /** Its corridor (null: none). */
    corridor?: number | null
    /** `cchain = corridor_c0 + corridor_sign · chain` */
    corridor_c0?: number | null
    corridor_sign?: number | null
    /** Chain end (mi): ≥ `length_mi`, since it includes gaps. */
    chain_mi?: number
    n_nodes?: number
    /** Other roads' crashes at its intersections; inclusive = `n_*` + `n_*_xs`. */
    n_crashes_xs?: number
    n_fatal_xs?: number
    n_injury_xs?: number
    n_killed_xs?: number
}

/** Whether a road comes from a v5 build (chainage, blocks, intersections, corridors). */
export function isV5(e: RoadEntity | null | undefined): e is RoadEntity & { chain_mi: number } {
    return !!e && typeof e.chain_mi === "number"
}

/** A group of entities that are one right-of-way (`road-corridors`). */
export type RoadCorridor = {
    corridor: number
    slug: string
    name: string
    kind: "sequential" | "parallel" | "mixed"
    spine: number
    /** Comma-joined member entity ids. */
    entities: string
    n_entities: number
    cc: number | null
    chain_mi: number
    length_mi: number
    lon_min: number
    lat_min: number
    lon_max: number
    lat_max: number
    n_crashes: number
    n_fatal: number
    n_injury: number
    n_killed: number
    n_crashes_xs: number
    n_fatal_xs: number
    n_injury_xs: number
    n_killed_xs: number
}

/** A road cut at its intersections (`road-blocks`); counts are this road's placed crashes with
 *  chain in `[chain_lo, chain_hi)` (exclusive of other roads' crashes). */
export type RoadBlock = {
    entity: number
    block: number
    chain_lo: number
    chain_hi: number
    length_mi: number
    node_lo: number | null
    node_hi: number | null
    from_name: string | null
    to_name: string | null
    n_crashes: number
    n_fatal: number
    n_injury: number
    n_killed: number
}

/** Crash counts of one road per `(year[, month], severity)` (`road-summary[-monthly]`); only
 *  non-zero cells have a row. `n` counts every crash on the road, `n_unplaced` those of them
 *  located by street name / route only (no map point; absent in builds before location recovery). */
export type RoadSummaryRow = {
    year: number
    /** 1–12 (monthly file only). */
    month?: number
    severity: string
    n: number
    tk: number
    ti: number
    n_unplaced?: number
    /** v5: of `n`, crashes at an intersection node. */
    n_node?: number
    /** v5: other roads' crashes at this road's intersections (crashes / killed / injured). */
    n_xs?: number
    tk_xs?: number
    ti_xs?: number
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

/** How `njdot roads build` put a crash on its road (specs/crash-location-recovery.md): its coded
 *  SRI / milepost (`sri_mp`), or, recovered from police-reported strings, the road ∩ cross street
 *  (`intersection` / `route_xs`), a reported point snapped to the road (`latlon_snap`), a retired
 *  route's milepost calibrated onto today's road (`sri_calib`, v5), or, with no point, an SRI
 *  without milepost (`sri_only`) or the road name alone (`name_only`). */
export type LocSource =
    | "sri_mp" | "intersection" | "route_xs" | "latlon_snap" | "sri_calib" | "sri_only" | "name_only" | "none"

/** Sources that put a crash on a road without a map point (no milepost, no lat / lon). */
export const UNPLACED_SOURCES: readonly LocSource[] = ["sri_only", "name_only"]

export function isUnplaced(c: { loc_source?: LocSource | null }): boolean {
    return !!c.loc_source && UNPLACED_SOURCES.includes(c.loc_source)
}

export type RoadCrash = {
    entity?: number
    /** Null for crashes located by street name only. */
    sri: string | null
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
    /** Absent in builds before location recovery (all crashes were `sri_mp`). */
    loc_source?: LocSource | null
    // v5 (absent in v4 builds):
    /** Chain (mi) along its road; null when unplaced. */
    chain?: number | null
    /** Unplaced crashes a cross street pins near an intersection: the node's chain ± the police
     *  distance. */
    chain_lo?: number | null
    chain_hi?: number | null
    /** The intersection node it's at. */
    node?: number | null
    /** `crashes-by-entity-xs` rows only: the road the crash is on (this row counts it at one of
     *  that road's intersections with `entity`). */
    own_entity?: number | null
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
        SELECT ${presentCols(["year", ...(monthly ? ["month"] : []), "severity", "n", "tk", "ti", "n_unplaced"])}
        FROM read_parquet('${roadsUrl(file)}') WHERE entity = ${entity | 0}
    `)
}

/** Every ranked road of a county (`mc` = 0) or muni; callers sort / filter by a metric's rank. */
export function fetchRoadRanks(db: AsyncDuckDB, cc: number, mc: number): Promise<RoadRank[]> {
    return runQuery<RoadRank>(db, `SELECT * FROM read_parquet('${roadsUrl("road-ranks")}') WHERE cc = ${cc | 0} AND mc = ${mc | 0}`)
}

/** The entity's points: `sri-geom` is sorted by `(entity, sri, mp)`, so the `entity` filter alone
 *  prunes to its row groups (no need to wait for its SRI list). v5 points carry `chain`. */
export function fetchEntityGeom(db: AsyncDuckDB, entity: number): Promise<(RoadPoint & { chain?: number })[]> {
    return runQuery<RoadPoint & { chain?: number }>(db, `
        SELECT ${presentCols([...POINT_COLS.split(", "), "chain"])} FROM read_parquet('${roadsUrl("sri-geom")}')
        WHERE entity = ${entity | 0}
        ORDER BY sri, mp
    `)
}

/** A DuckDB `COLUMNS(…)` selecting whichever of `cols` the file has: columns added by newer builds
 *  (`loc_source`, `n_unplaced`) are just absent from rows of older ones, rather than failing the
 *  query (road data and the site deploy separately). */
function presentCols(cols: readonly string[]): string {
    return `COLUMNS('^(${cols.join("|")})$')`
}

/** `crashes-by-entity` is sorted by `(entity, unplaced, chain, dt, id)` (v5; v4: `sri, mp` for
 *  `chain`), so the `entity` filter alone prunes to the road's row groups (no need to wait for its
 *  SRI list). Crashes without a map position sort last. `v5`: order by `chain` (v4 files have
 *  none, and an `ORDER BY` of a missing column fails). */
export function entityCrashesSql(entity: number, v5: boolean): string {
    const order = v5 ? "chain IS NULL, chain, dt" : "mp IS NULL, sri, mp, dt"
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${entity | 0} ORDER BY ${order}`
}

/** What the road views (table, map, plots) read; Export CSV fetches every column on demand. The
 *  v5 columns are absent from rows of v4 builds. */
const VIEW_COLS = [
    "sri", "mp", "id", "year", "dt", "cc", "mc", "case", "severity", "tk", "ti", "cross_street", "lat", "lon", "loc_source",
    "chain", "chain_lo", "chain_hi", "node", "entity",
] as const
export type RoadCrashView = Pick<RoadCrash, typeof VIEW_COLS[number]> & {
    /** `crashes-by-entity-xs` rows: the road the crash is on. */
    own_entity?: number | null
}

const viewCols = (extra: string[] = []) => `${presentCols([...VIEW_COLS.filter(c => c !== "dt"), ...extra])}, epoch_ms(dt) AS dt`

export function fetchEntityCrashes(db: AsyncDuckDB, entity: number, v5: boolean): Promise<RoadCrashView[]> {
    return runQuery<RoadCrashView>(db, `SELECT ${viewCols()} FROM (${entityCrashesSql(entity, v5)})`)
}

export function fetchEntityCrashesFull(db: AsyncDuckDB, entity: number, v5: boolean): Promise<RoadCrash[]> {
    return runQuery<RoadCrash>(db, `SELECT * EXCLUDE (dt), epoch_ms(dt) AS dt FROM (${entityCrashesSql(entity, v5)})`)
}

/** Other roads' crashes at this road's intersections (`crashes-by-entity-xs`, v5): `chain` is the
 *  intersection's chain on this road, `own_entity` the road the crash is on. */
/** A span's `chain` predicate (`spanBounds`: `[lo, hi)`, closed at the road's end). */
function chainRange(span: Span, hiClosed: boolean): string {
    const b = spanBounds(span, hiClosed)
    return `chain >= ${b.min} AND chain ${b.maxInclusive ? "<=" : "<"} ${b.max}`
}

export function entityXsSql(entity: number, span?: Span, hiClosed = true): string {
    const range = span ? ` AND ${chainRange(span, hiClosed)}` : ""
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-entity-xs")}') WHERE entity = ${entity | 0}${range} ORDER BY chain, dt`
}

export function fetchEntityXs(db: AsyncDuckDB, entity: number, span?: Span, hiClosed = true): Promise<RoadCrashView[]> {
    return runQuery<RoadCrashView>(db, `SELECT ${viewCols(["own_entity"])} FROM (${entityXsSql(entity, span, hiClosed)})`)
}

/** A road's crashes in chain range `span`, plus its unplaced crashes pinned there (a cross street
 *  puts them within `[chain_lo, chain_hi]`). Two `UNION ALL`ed scans, so the placed one prunes on
 *  `chain` stats (an `OR` wouldn't). */
export function spanCrashesSql(entity: number, span: Span, hiClosed = true): string {
    const src = `read_parquet('${roadsUrl("crashes-by-entity")}')`
    const e = entity | 0
    return `SELECT * FROM (
        SELECT * FROM ${src} WHERE entity = ${e} AND ${chainRange(span, hiClosed)}
        UNION ALL SELECT * FROM ${src} WHERE entity = ${e} AND chain IS NULL AND chain_lo <= ${+span.hi} AND chain_hi >= ${+span.lo}
    ) ORDER BY chain IS NULL, chain, dt`
}

export function fetchSpanCrashes(db: AsyncDuckDB, entity: number, span: Span, hiClosed: boolean): Promise<RoadCrashView[]> {
    return runQuery<RoadCrashView>(db, `SELECT ${viewCols()} FROM (${spanCrashesSql(entity, span, hiClosed)})`)
}

/** The road's blocks, in chain order (`road-blocks`, v5). */
export function fetchBlocks(db: AsyncDuckDB, entity: number): Promise<RoadBlock[]> {
    return runQuery<RoadBlock>(db, `SELECT * FROM read_parquet('${roadsUrl("road-blocks")}') WHERE entity = ${entity | 0} ORDER BY block`)
}

export async function fetchCorridor(db: AsyncDuckDB, corridor: number): Promise<RoadCorridor | null> {
    const rows = await runQuery<RoadCorridor>(db, `SELECT * FROM read_parquet('${roadsUrl("road-corridors")}') WHERE corridor = ${corridor | 0}`)
    return rows[0] ?? null
}

/** `entity, name` of each id in `ids`: one `BETWEEN` scan per cluster of nearby ids (entities are
 *  slug-ordered, so a road's cross streets are mostly close; DuckDB-WASM doesn't prune on `IN`). */
export async function fetchEntityNames(db: AsyncDuckDB, ids: readonly number[]): Promise<Map<number, string>> {
    const sorted = [...new Set(ids.map(i => i | 0))].sort((a, b) => a - b)
    const ranges: [number, number][] = []
    for (const id of sorted) {
        const last = ranges[ranges.length - 1]
        if (last && id - last[1] <= 200) last[1] = id
        else ranges.push([id, id])
    }
    const results = await Promise.all(ranges.map(([a, b]) => runQuery<{ entity: number; name: string }>(db, `
        SELECT entity, name FROM read_parquet('${roadsUrl("road-entities")}') WHERE entity BETWEEN ${a} AND ${b}
    `)))
    const want = new Set(sorted)
    const out = new Map<number, string>()
    for (const rows of results) for (const r of rows) if (want.has(r.entity)) out.set(r.entity, r.name)
    return out
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
