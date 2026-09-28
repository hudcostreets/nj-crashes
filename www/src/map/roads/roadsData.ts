/** Road data (specs/road-data-v4.md): parquets built by `njdot roads build`, read with ranged
 *  reads (`@/src/lib/pq`, specs/off-duckdb-wasm.md). Each file is sorted for row-group pruning: `sri-hit` spatially (a viewport bbox
 *  reads a few groups), `crashes-by-sri` / `sris` by `sri`, the rest (incl. `sri-geom`) by `entity`
 *  (= `slug` order, so a county's / muni's roads are contiguous). */
import { openParquet, planRead, readRows, type Filter, type SortKey } from "@/src/lib/pq"
import { MAP_BASE_URL } from "@/src/map/config"
import { noteFilter, type NoteTarget, type RoadNoteRow } from "./roadNotes"
import { spanBounds, type BlockCounts, type SpanSel } from "./roadScope"

const { cos, PI, sqrt } = Math

/** Sibling of the map geometry dir (`…/njdot/map` → `…/njdot/roads`). */
export const ROADS_BASE_URL = MAP_BASE_URL.replace(/\/map\/?$/, "/roads")

export type RoadsFile =
    | "crashes-by-sri" | "crashes-by-entity" | "sri-geom" | "sri-hit" | "sri-hit-5" | "sri-hit-6"
    | "sris" | "road-entities" | "road-runs" | "road-summary" | "road-summary-monthly" | "road-ranks"
    | "road-search" | "crashes-by-entity-xs" | "road-blocks" | "road-node-entities" | "road-corridors"
    | "road-corridor-summary" | "road-corridor-summary-monthly" | "road-notes"

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

/** A road cut at its intersections (`road-blocks`): `n_*` count this road's placed crashes in it,
 *  `n_*_xs` (v5.1) other roads' crashes at its intersections (a crash at a node counts in the block
 *  that starts there). v5.1: exactly the `crashes-by-entity{,-xs}` rows with this `block`. */
export type RoadBlock = BlockCounts & {
    entity: number
    chain_lo: number
    chain_hi: number
    length_mi: number
    node_lo: number | null
    node_hi: number | null
    from_name: string | null
    to_name: string | null
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
    /** v5.1: of `n`, `corridor_only` crashes (located to the corridor, not a side of it). */
    n_corridor_only?: number
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
    // v5.1 (absent in earlier builds):
    /** Its block on `entity` (`road-blocks.block`); null when unplaced. */
    block?: number | null
    /** Its road name is several members of one corridor and nothing picks the side: `entity` is a
     *  representative, and it has no point or position along it. */
    corridor_only?: boolean | null
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

const POINT_COLS = ["sri", "mp", "sld_name", "name", "subt", "entity", "alias", "lon", "lat"]

export function fetchHitPoints(file: RoadsFile, [w, s, e, n]: Bbox): Promise<RoadPoint[]> {
    return readRows<RoadPoint>(roadsUrl(file), {
        columns: POINT_COLS,
        filter: { lon: { $gte: w, $lte: e }, lat: { $gte: s, $lte: n } },
    })
}

/** `road-entities` rows by id, filled a whole row group (1000 slug-ordered roads, ~65 KB) per read:
 *  hovering across a street grid touches a handful of groups, so after the first read of each,
 *  lookups are synchronous (`peekEntity`) and issue no request. */
const entityRows = new Map<number, RoadEntity>()
const entitySlugs = new Map<string, RoadEntity>()
/** The in-flight group read, so concurrent lookups in one group share it. */
let entityRead: Promise<unknown> = Promise.resolve()

function readEntityGroups(filter: Filter): Promise<void> {
    const p = entityRead.catch(() => {}).then(() => readRows<RoadEntity>(roadsUrl("road-entities"), { filter, wholeGroups: true }))
        .then(rows => {
            for (const r of rows) {
                entityRows.set(r.entity, r)
                entitySlugs.set(r.slug, r)
            }
        })
    entityRead = p
    return p
}

/** A road entity, if its row group has been read (no I/O). */
export function peekEntity(entity: number): RoadEntity | undefined {
    return entityRows.get(entity | 0)
}

export async function fetchEntity(entity: number): Promise<RoadEntity | null> {
    const id = entity | 0
    if (!entityRows.has(id)) {
        // Another lookup's read may be loading this group already.
        await entityRead.catch(() => {})
        if (!entityRows.has(id)) await readEntityGroups({ entity: id })
    }
    return entityRows.get(id) ?? null
}

/** Row groups `prefetchEntities` reads at most (~65 KB each); a wider view skips the warm-up. */
export const ENTITY_PREFETCH_MAX_GROUPS = 4

/** Warm `fetchEntity` / `peekEntity` for `ids` (e.g. the roads in view): one read of the groups
 *  holding the not-yet-cached ones, unless that's more than `maxGroups` groups. */
export async function prefetchEntities(ids: Iterable<number>, maxGroups = ENTITY_PREFETCH_MAX_GROUPS): Promise<void> {
    const want = [...new Set([...ids].map(i => i | 0))].filter(i => !entityRows.has(i)).sort((a, b) => a - b)
    if (!want.length) return
    const filter: Filter = { entity: { $in: want } }
    const { groups } = planRead(await openParquet(roadsUrl("road-entities")), { columns: ["entity"], filter })
    if (groups.length > maxGroups) return
    await readEntityGroups(filter)
}

export async function fetchEntityBySlug(slug: string): Promise<RoadEntity | null> {
    if (!isRoadSlug(slug)) return null
    if (!entitySlugs.has(slug)) {
        await entityRead.catch(() => {})
        if (!entitySlugs.has(slug)) await readEntityGroups({ slug })
    }
    return entitySlugs.get(slug) ?? null
}

const SUMMARY_COLS = ["severity", "n", "tk", "ti", "n_unplaced", "n_node", "n_xs", "tk_xs", "ti_xs", "n_corridor_only"]

/** The road's crash counts per `(year, severity)`, or per `(year, month, severity)` with `monthly`.
 *  Columns a build doesn't have are absent from its rows (`readRows` `columns` are present-only). */
export function fetchEntitySummary(entity: number, monthly: boolean): Promise<RoadSummaryRow[]> {
    return readRows<RoadSummaryRow>(roadsUrl(monthly ? "road-summary-monthly" : "road-summary"), {
        columns: ["year", ...(monthly ? ["month"] : []), ...SUMMARY_COLS],
        filter: { entity: entity | 0 },
    })
}

/** A corridor's crash counts per `(year, month, severity)` (`road-corridor-summary-monthly`, v5.1;
 *  the read fails on builds without it). `n_xs` counts crashes at its intersections on roads
 *  outside it, once each. */
export function fetchCorridorSummary(corridor: number): Promise<RoadSummaryRow[]> {
    return readRows<RoadSummaryRow>(roadsUrl("road-corridor-summary-monthly"), {
        columns: ["year", "month", ...SUMMARY_COLS],
        filter: { corridor: corridor | 0 },
    })
}

/** Every ranked road of a county (`mc` = 0) or muni; callers sort / filter by a metric's rank. */
export function fetchRoadRanks(cc: number, mc: number): Promise<RoadRank[]> {
    return readRows<RoadRank>(roadsUrl("road-ranks"), { filter: { cc: cc | 0, mc: mc | 0 } })
}

/** The entity's points: `sri-geom` is sorted by `(entity, sri, mp)`, so the `entity` filter alone
 *  prunes to its row groups (no need to wait for its SRI list). v5 points carry `chain`. */
export function fetchEntityGeom(entity: number): Promise<(RoadPoint & { chain?: number })[]> {
    return readRows<RoadPoint & { chain?: number }>(roadsUrl("sri-geom"), {
        columns: [...POINT_COLS, "chain"],
        filter: { entity: entity | 0 },
        orderBy: ["sri", "mp"],
    })
}

/** Along the road: v5 by `chain` (unplaced last), then date; v4 (no `chain`) by `sri, mp`. */
function crashOrder(v5: boolean): SortKey<RoadCrash>[] {
    return v5 ? ["chain", "dt"] : [c => c.mp === null, "sri", "mp", "dt"]
}

/** `crashes-by-entity` is sorted by `(entity, unplaced, chain, dt, id)` (v5; v4: `sri, mp` for
 *  `chain`), so the `entity` filter alone prunes to the road's row groups (no need to wait for its
 *  SRI list). Crashes without a map position sort last. `v5`: order by `chain` (v4 files have
 *  none). The SQL twin, for "Open in SQL". */
export function entityCrashesSql(entity: number, v5: boolean): string {
    const order = v5 ? "chain IS NULL, chain, dt" : "mp IS NULL, sri, mp, dt"
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-entity")}') WHERE entity = ${entity | 0} ORDER BY ${order}`
}

/** What the road views (table, map, plots) read; Export CSV fetches every column on demand. The
 *  v5 columns are absent from rows of v4 builds. */
const VIEW_COLS = [
    "sri", "mp", "id", "year", "dt", "cc", "mc", "case", "severity", "tk", "ti", "cross_street", "lat", "lon", "loc_source",
    "chain", "chain_lo", "chain_hi", "node", "entity", "block", "corridor_only",
] as const
export type RoadCrashView = Pick<RoadCrash, typeof VIEW_COLS[number]> & {
    /** `crashes-by-entity-xs` rows: the road the crash is on. */
    own_entity?: number | null
}

export function fetchEntityCrashes(entity: number, v5: boolean): Promise<RoadCrashView[]> {
    return readRows<RoadCrashView>(roadsUrl("crashes-by-entity"), {
        columns: VIEW_COLS,
        filter: { entity: entity | 0 },
        orderBy: crashOrder(v5) as SortKey<RoadCrashView>[],
    })
}

export function fetchEntityCrashesFull(entity: number, v5: boolean): Promise<RoadCrash[]> {
    return readRows<RoadCrash>(roadsUrl("crashes-by-entity"), { filter: { entity: entity | 0 }, orderBy: crashOrder(v5) })
}

/** A span's placed-crash predicate (`SpanSel`): `block BETWEEN b0 AND b1` (v5.1 block-aligned
 *  spans; `block` has no stats, so this prunes on `entity` only), else `chain` in `[lo, hi)`
 *  (`spanBounds`, closed at the road's end). */
export function spanPredicate({ span, hiClosed, blocks }: SpanSel): string {
    if (blocks) return `block BETWEEN ${blocks[0] | 0} AND ${blocks[1] | 0}`
    const b = spanBounds(span, hiClosed)
    return `chain >= ${+b.min} AND chain ${b.maxInclusive ? "<=" : "<"} ${+b.max}`
}

/** `spanPredicate` as a `readRows` filter. */
export function spanFilter({ span, hiClosed, blocks }: SpanSel): Filter {
    if (blocks) return { block: { $gte: blocks[0] | 0, $lte: blocks[1] | 0 } }
    const b = spanBounds(span, hiClosed)
    return { chain: b.maxInclusive ? { $gte: +b.min, $lte: +b.max } : { $gte: +b.min, $lt: +b.max } }
}

/** Other roads' crashes at this road's intersections (`crashes-by-entity-xs`, v5): `chain` is the
 *  intersection's chain on this road, `own_entity` the road the crash is on. */
export function entityXsSql(entity: number, sel?: SpanSel): string {
    const range = sel ? ` AND ${spanPredicate(sel)}` : ""
    return `SELECT * FROM read_parquet('${roadsUrl("crashes-by-entity-xs")}') WHERE entity = ${entity | 0}${range} ORDER BY chain, dt`
}

export function fetchEntityXs(entity: number, sel?: SpanSel): Promise<RoadCrashView[]> {
    return readRows<RoadCrashView>(roadsUrl("crashes-by-entity-xs"), {
        columns: [...VIEW_COLS, "own_entity"],
        filter: { entity: entity | 0, ...(sel ? spanFilter(sel) : {}) },
        orderBy: ["chain", "dt"],
    })
}

/** A road's crashes in a span (`spanPredicate`), plus its unplaced crashes pinned there (a cross
 *  street puts them within `[chain_lo, chain_hi]`), except `corridor_only` ones (their side is
 *  unknown; `v51`: the build has that column). The SQL twin (for "Open in SQL") `UNION ALL`s two
 *  scans, so DuckDB-WASM's `chain` range prunes on its stats (an `OR` wouldn't). */
export function spanCrashesSql(entity: number, sel: SpanSel, v51: boolean): string {
    const src = `read_parquet('${roadsUrl("crashes-by-entity")}')`
    const e = entity | 0
    const { lo, hi } = sel.span
    const side = v51 ? " AND NOT coalesce(corridor_only, false)" : ""
    return `SELECT * FROM (
        SELECT * FROM ${src} WHERE entity = ${e} AND ${spanPredicate(sel)}
        UNION ALL SELECT * FROM ${src} WHERE entity = ${e} AND chain IS NULL AND chain_lo <= ${+hi} AND chain_hi >= ${+lo}${side}
    ) ORDER BY chain IS NULL, chain, dt`
}

/** `spanCrashesSql` as one read: an `$or` prunes row groups when both its branches do. */
export function spanCrashesFilter(entity: number, sel: SpanSel, v51: boolean): Filter {
    const { lo, hi } = sel.span
    const pinned: Filter = {
        chain: null,
        chain_lo: { $lte: +hi },
        chain_hi: { $gte: +lo },
        ...(v51 ? { $or: [{ corridor_only: null }, { corridor_only: false }] } : {}),
    }
    return { entity: entity | 0, $or: [spanFilter(sel), pinned] }
}

export function fetchSpanCrashes(entity: number, sel: SpanSel, v51: boolean): Promise<RoadCrashView[]> {
    return readRows<RoadCrashView>(roadsUrl("crashes-by-entity"), {
        columns: VIEW_COLS,
        filter: spanCrashesFilter(entity, sel, v51),
        orderBy: ["chain", "dt"],
    })
}

/** The road's blocks, in chain order (`road-blocks`, v5). */
export function fetchBlocks(entity: number): Promise<RoadBlock[]> {
    return readRows<RoadBlock>(roadsUrl("road-blocks"), { filter: { entity: entity | 0 }, orderBy: ["block"] })
}

export async function fetchCorridor(corridor: number): Promise<RoadCorridor | null> {
    const rows = await readRows<RoadCorridor>(roadsUrl("road-corridors"), { filter: { corridor: corridor | 0 } })
    return rows[0] ?? null
}

/** A road's or corridor's data notes (`road-notes`; absent from builds before
 *  specs/road-anomalies.md, where the read fails). */
export function fetchRoadNotes(target: NoteTarget): Promise<RoadNoteRow[]> {
    return readRows<RoadNoteRow>(roadsUrl("road-notes"), { filter: noteFilter(target) })
}

/** `entity, name` of each id in `ids`: one `IN` read (pruned to the row groups whose `entity`
 *  range holds one of them; entities are slug-ordered, so a road's cross streets are mostly close). */
export async function fetchEntityNames(ids: readonly number[]): Promise<Map<number, string>> {
    const want = [...new Set(ids.map(i => i | 0))].sort((a, b) => a - b)
    if (!want.length) return new Map()
    const rows = await readRows<{ entity: number; name: string }>(roadsUrl("road-entities"), {
        columns: ["entity", "name"],
        filter: { entity: { $in: want } },
    })
    return new Map(rows.map(r => [r.entity, r.name]))
}

/** The road entity a crash was matched to (null when it has no SRI match, or its point isn't on a
 *  road entity): `crashes-by-sri` is sorted by `sri`, so the SRI filter prunes to its row groups.
 *  Matches on `id`, or on the 4-field PK for rows without one (2024+). */
export async function fetchCrashEntity(
    crash: { id: number | null; sri: string; year: number; cc: number; mc: number; case: string },
): Promise<number | null> {
    if (!isSri(crash.sri)) return null
    const pk: Filter = { year: crash.year | 0, cc: crash.cc | 0, mc: crash.mc | 0, case: crash.case }
    const match: Filter = crash.id !== null ? { $or: [{ id: crash.id | 0 }, { id: null, ...pk }] } : pk
    const rows = await readRows<{ entity: number }>(roadsUrl("crashes-by-sri"), {
        columns: ["entity"],
        filter: { sri: crash.sri, ...match },
        limit: 1,
    })
    return rows[0]?.entity ?? null
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

/** Same road as far as the hover UI shows it (entity, name, alias); a hover that stays on it keeps
 *  the previous point, so moving along a road doesn't re-render the map. */
export function sameRoad(a: RoadPoint | null, b: RoadPoint | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.entity === b.entity && a.name === b.name && a.alias === b.alias
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
