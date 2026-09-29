/** `/v1/cells` request handler. S2 is the only grid — the H3 half of
 *  this file died with `specs/h3-removal.md` Phase 2.
 *
 *  **Shard-keyed.** The client names the S2 parent cells covering its
 *  viewport (`S2_STATEWIDE_SHARDS`: NJ is two l4 cells) plus the level
 *  it wants. Each (shard, level, years, sevs, polygon_hash) is
 *  independently cacheable on the client; panning within already-
 *  fetched shards = zero worker invocations.
 *
 *  Because the S2 cover is the whole state at every zoom, the *shard*
 *  ranges prune nothing — the tightening comes from covering the clip
 *  polygon (`s2RangesForPolygon`) and intersecting. That's what keeps a
 *  street-zoom request from decoding an entire 63 MB level file.
 *
 *  Two query paths:
 *  - **D1** (`cells_s2_l{level}`): one indexed `cellid BETWEEN` lex-range
 *    scan returning counts (+ labels). All-years requests read the rollup's
 *    count columns; a year sub-range (and `group=year`) reads its `by_year`
 *    column — per-year counts packed as TEXT, summed here (`by-year.ts`,
 *    `specs/cells-d1-years.md`).
 *  - **Parquet pyramid** (`s2_pyramid/s2_l{level}/{token}.parquet`):
 *    year-filterable, row-group-pruned by the same ranges. The fallback
 *    whenever the D1 path errors — including D1 tables that predate
 *    `by_year` — and the only path for `labels=only`.
 *
 *  Response shape:
 *
 *      {
 *        res: number,                    // the level actually served
 *        year_range: [number, number],
 *        data_version: string,
 *        source: "pyramid" | "d1",
 *        labels: "full" | "nums" | "only",
 *        cells: [{ cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped }]
 *      }
 *
 *  The cell key rode a vestigial `h3` wire field until h3-removal Phase
 *  4b renamed it to `cellid` (worker + client moved together).
 *
 *  `format=cols` (opt-in, additive — the default above is unchanged) returns
 *  the same cells as sorted parallel arrays of just the requested `fields`
 *  (`CellsColsResponse`, `toColumnar`); see `specs/cells-compact-wire-format.md`.
 */
import { S2CellId, S2LatLng, S2LatLngRect, S2RegionCoverer } from "nodes2ts"
import { BY_YEAR_IDX, N_BY_YEAR, forEachYear, sumByYear } from "./by-year"
import { type Manifest, MANIFEST_TTL_MS, d1Table, loadManifest, pyramidShardKey } from "./manifest"
import { readParquetFromR2 } from "./parquet"
import type { Timing } from "./timing"
import {
    type S2CellRange,
    intersectRanges,
    mergeRanges,
    s2IdToToken,
    s2LevelOf,
    s2Parent,
    s2RangeForCell,
    s2TokenToId,
} from "pyrmts-geo"

/** GeoJSON-like polygon: outer ring as `[lon, lat][]`. We keep just one
 *  ring; multi-ring (holes) doesn't show up for our use cases. */
type LonLatPolygon = [number, number][]

/** Levels the pyramid builds (`njdot compute cells pyramid --grid s2`).
 *  Mirrors the client's `S2_MIN_LEVEL`/`S2_MAX_LEVEL` in
 *  `www/src/map/s2/edges.ts` — a request outside this envelope 400s
 *  rather than 404ing on a missing R2 key. */
const S2_MIN_LEVEL = 4
const S2_MAX_LEVEL = 21

/** One row of `s2_pyramid/s2_l{level}/{shard}.parquet` (written by
 *  `njdot compute cells pyramid --grid s2`, see `_build_pyramid_level_s2`).
 *  One row per (cell, year); the four label columns are baked in at build
 *  time and are constant across a cell's year-rows. */
type PyramidRowS2 = {
    cellid: string
    year: number
    n_fatal?: number
    n_inj_ped?: number
    n_inj_other?: number
    n_pdo?: number
    n_vehs?: number
    n_killed?: number
    n_killed_ped?: number
    sld_name?: string | null
    cross_sld_name?: string | null
    mun?: string | null
    county?: string | null
}

export type CellOut = {
    /** S2 token. Wire key was `h3` until h3-removal Phase 4b. */
    cellid: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
    /** People killed / pedestrians killed in this cell (broad `tk`/`pk` sums —
     *  the AASHTO death totals, not the strict `severity='f'` crash count, so
     *  `n_killed` can differ slightly from `n_fatal`). Severity-blind like
     *  `n_vehs`. Feeds the Tier-1 viewport "deaths" stat (see
     *  specs/map-viewport-stats-and-rendering.md). */
    n_killed: number
    n_killed_ped: number
    /** Years (ascending) in which this cell had ≥1 fatal crash. Omitted
     *  when n_fatal === 0. Used by the hex tooltip to show "Fatal: 2018,
     *  2020, 2022" instead of just a bare count. */
    fatal_years?: number[]
    /** Primary road at this cell's centroid, baked into every pyramid /
     *  rollup row at build time (joined from `s2-sld.parquet`). Omitted
     *  for ocean/off-road cells. Used by the cell tooltip; replaced the
     *  15 MB client-side sidecar fetch and the former per-request
     *  `joinSld` read. */
    sld_name?: string
    /** Cross-street from the same baked source. Populated for cells within
     *  ~80m of a different SRI; ~25-75% of cells depending on res. */
    cross_sld_name?: string
    mun?: string
    county?: string
}

export type CellsResponse = {
    /** The level actually served — coarser than requested when `maxCells`
     *  forced an in-worker roll-up. */
    res: number
    year_range: [number, number]
    data_version: string
    source: "pyramid" | "d1"
    /** Label mode actually served, which is not always the one requested:
     *  `full` degrades to `nums` past `labelMaxCells`. */
    labels?: "full" | "nums" | "only"
    cells: CellOut[]
}

/** Count columns a `format=cols` request may ask for via `fields=`. Labels
 *  and `fatal_years` are row-format-only. */
export const COUNT_FIELDS = ["n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "n_killed", "n_killed_ped"] as const
export type CountField = typeof COUNT_FIELDS[number]

/** `format=cols` response: the row response's envelope, with `cells`
 *  replaced by sorted parallel arrays.
 *
 *  `cols.cellid` is prefix-delta encoded against the previous entry: the
 *  first char is the shared-prefix length as one hex digit (tokens are ≤16
 *  chars and distinct, so a shared prefix is ≤15), the rest is the suffix.
 *  Entry 0 has prefix length 0 (`"0" + token`). Sorted S2 tokens sit on the
 *  Hilbert curve, so neighbors share long prefixes and the average entry is
 *  a few chars instead of ~17. Decode: `prev.slice(0, parseInt(e[0], 16)) + e.slice(1)`. */
export type CellsColsResponse = Omit<CellsResponse, "cells"> & {
    format: "cols"
    cellid_enc: "prefix-hex1"
    n: number
    cols: { cellid: string[] } & Partial<Record<CountField, number[]>>
}

/** `format=cols&group=year` response: per-(cell, year) counts, so a client
 *  can re-aggregate any year sub-range locally instead of re-fetching on
 *  every year-filter change (see `specs/map-mobile-perf.md`).
 *
 *  `cols.cellid` holds the *distinct* cells (sorted, prefix-delta encoded as
 *  in `CellsColsResponse`); `cols.nyears[i]` is how many year-rows cell `i`
 *  owns. `cols.year` and the count columns are flat, `sum(nyears)` long,
 *  grouped by cell in `cellid` order, years ascending within a cell. Only
 *  (cell, year) rows with ≥1 crash of a requested severity are present. */
export type CellsColsYearResponse = Omit<CellsResponse, "cells"> & {
    format: "cols"
    group: "year"
    cellid_enc: "prefix-hex1"
    /** Distinct cells. */
    n: number
    /** (cell, year) rows. */
    n_rows: number
    cols: { cellid: string[]; nyears: number[]; year: number[] } & Partial<Record<CountField, number[]>>
}

export type CellsRequest = {
    /** Parent S2 cells (tokens) the client wants data for; the worker
     *  reads one pyramid file per shard, in order. Unknown shards (no
     *  parquet at that key) are silently skipped. NJ is two l4 cells, so
     *  in practice this is a constant — the viewport tightening happens
     *  via `clipPolygon`, not here. */
    cells: string[]
    /** S2 level to aggregate to, in `[S2_MIN_LEVEL, S2_MAX_LEVEL]`. */
    res: number
    yearRange?: [number, number]
    severities?: Set<"f" | "i" | "p">
    /** Optional polygon to clip the response to. Cells whose center is
     *  not in the polygon are dropped. Used for county/muni scopes so
     *  the embed for `/c/hudson` doesn't show neighboring cells that
     *  happen to fall in a requested shard — and, since the shard cover
     *  is statewide, it's also what makes range pruning bite at all. */
    clipPolygon?: LonLatPolygon
    /** Optional max cell count. If the response at the requested `res`
     *  would exceed this, the worker walks coarser (drops the fetched
     *  pyramid, reads the next-coarser one) until it fits or hits MIN.
     *  Result includes `res: actualRes` so the client knows what
     *  resolution was actually returned. */
    maxCells?: number
    /** Level the shard tokens in `cells` sit at. Informational — the
     *  worker derives each shard's own level from its token. Parsed and
     *  validated so a malformed client request fails loudly rather than
     *  being ignored. */
    shardRes?: number
    /** Which columns to materialize, splitting the expensive string-label
     *  decode off the paint critical path (labels are ~37% of decode but
     *  tooltip-only). Default `full` = counts + labels (back-compat).
     *  - `nums`: counts only (drops sld_name/cross_sld_name/mun/county).
     *    Paints the map + bars; ~37% faster decode.
     *  - `only`: labels only, keyed by cellid — the backfill/hover request the
     *    client merges into already-painted cells. Year-invariant, so no
     *    year filter; deduped by cellid; count fields are 0. */
    labels?: "full" | "nums" | "only"
    /** Cell-count ceiling above which `labels=full` degrades to `nums`.
     *
     *  Labels cost ~90 B/cell on the wire and are useful only when the
     *  user can hover a specific cell; the bins budget keeps cells at
     *  1-5 px, so a wide view asks for tens of thousands of them and
     *  spends megabytes on street names nobody can target. Measured
     *  2026-08-22: a statewide-mid l14 view is 36k cells / 5.97 MB, of
     *  which 2.97 MB is the four string columns. Capping here bounds
     *  that without the client having to predict its own cell count.
     *  The response reports the mode actually served. */
    labelMaxCells?: number
    /** Wire shape. `rows` (default) = `CellsResponse`, unchanged; `cols` =
     *  `CellsColsResponse`, label-less (`labels` must be unset or `nums`). */
    format?: "rows" | "cols"
    /** `format=cols` only: which count columns to ship, in order. Default
     *  all of `COUNT_FIELDS`. The client names what it needs (heatmap C:
     *  the four severity counts) rather than the worker computing a
     *  derived weight, so weighting logic lives in exactly one place. */
    fields?: CountField[]
    /** `format=cols` only: `year` ⇒ `CellsColsYearResponse` (per-year rows,
     *  from D1's `by_year` column, else the parquet pyramid). */
    group?: "year"
    /** `group=year` only: ceiling on (cell, year) rows; the worker coarsens
     *  (like `maxCells`) until the response fits. */
    maxRows?: number
}

/** Capabilities this worker advertises on `/v1/manifest` (`capabilities`),
 *  so a client can feature-detect rather than infer from a response shape.
 *  A worker predating a capability omits it (and the whole field). */
export const CAPABILITIES = ["format_cols", "group_year", "server_timing", "edge_cache"] as const

/** Edge-cache key for a `/v1/cells` request: the URL with its query params
 *  sorted (so param order doesn't split entries), `severity` folded into
 *  `severities` with its chars sorted, and the manifest's `data_version`
 *  appended (so a pipeline push invalidates every entry). */
export function cellsCacheKey(url: URL, dataVersion: string): string {
    const params = [...url.searchParams.entries()]
        .filter(([k]) => k !== "severity" && k !== "severities" && k !== "__dv")
    const sev = url.searchParams.get("severity") ?? url.searchParams.get("severities")
    if (sev != null) params.push(["severities", [...sev].sort().join("")])
    params.sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    params.push(["__dv", dataVersion])
    return `${url.origin}${url.pathname}?${new URLSearchParams(params)}`
}

/** Default `group=year` row ceiling: ~12 B/row of JSON ⇒ ~3 MB decoded
 *  (~0.4 MB brotli) worst case. */
export const DEFAULT_MAX_YEAR_ROWS = 250_000

/** Default `labelMaxCells`. ~20k cells × ~90 B/cell ≈ 1.8 MB of labels
 *  worst case, and it lands above the muni/street views (0.5-10k cells)
 *  where hovering actually works, below the county/statewide ones
 *  (35-170k) where it doesn't. */
export const DEFAULT_LABEL_MAX_CELLS = 20_000

const LABEL_KEYS = ["sld_name", "cross_sld_name", "mun", "county"] as const

/** Drop the tooltip strings in place. Cheaper than re-querying, and the
 *  point is the wire size, not the D1 read. */
export function stripLabels(cells: CellOut[]): CellOut[] {
    for (const c of cells) {
        for (const k of LABEL_KEYS) delete c[k]
    }
    return cells
}

/** Apply the label cap and report the mode actually served. Mutates
 *  `cells` when it downgrades, so callers can return them directly. */
export function servedLabels(
    requested: "full" | "nums" | "only",
    cells: CellOut[],
    labelMaxCells: number = DEFAULT_LABEL_MAX_CELLS,
): "full" | "nums" | "only" {
    if (requested !== "full" || cells.length <= labelMaxCells) return requested
    stripLabels(cells)
    return "nums"
}

/** Longest shared prefix of two strings. */
function sharedPrefixLen(a: string, b: string): number {
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
    return i
}

/** Prefix-delta encode sorted, distinct S2 tokens (see `CellsColsResponse`). */
export function encodeTokens(tokens: string[]): string[] {
    const out: string[] = new Array(tokens.length)
    let prev = ""
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        const k = sharedPrefixLen(prev, t)
        if (k > 15) throw new Error(`token ${t} shares ${k} chars with its predecessor (duplicate?)`)
        out[i] = k.toString(16) + t.slice(k)
        prev = t
    }
    return out
}

/** Inverse of `encodeTokens`. */
export function decodeTokens(enc: string[]): string[] {
    const out: string[] = new Array(enc.length)
    let prev = ""
    for (let i = 0; i < enc.length; i++) {
        const e = enc[i]
        prev = prev.slice(0, parseInt(e[0], 16)) + e.slice(1)
        out[i] = prev
    }
    return out
}

/** Row response → `format=cols`. Sorts by cellid (lex order of stripped
 *  tokens = cell-id order at a fixed level), which is what makes the
 *  prefix-delta encoding bite; the row format's order was never a contract. */
export function toColumnar(r: CellsResponse, fields: readonly CountField[] = COUNT_FIELDS): CellsColsResponse {
    const { cells, ...envelope } = r
    const sorted = [...cells].sort((a, b) => a.cellid < b.cellid ? -1 : a.cellid > b.cellid ? 1 : 0)
    const cols: CellsColsResponse["cols"] = { cellid: encodeTokens(sorted.map(c => c.cellid)) }
    for (const f of fields) cols[f] = sorted.map(c => c[f])
    return { ...envelope, format: "cols", cellid_enc: "prefix-hex1", n: sorted.length, cols }
}

/** Standard ray-casting point-in-polygon. Polygon as `[lon, lat][]`,
 *  point as `[lon, lat]`. */
function pointInPolygon(pt: [number, number], poly: LonLatPolygon): boolean {
    const [x, y] = pt
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

/** Point-in-polygon test for an S2 cell, keyed by its token. Resolves
 *  the cell's centroid on the sphere via `nodes2ts.S2CellId.toPoint`,
 *  projects to (lng, lat), then reuses `pointInPolygon`. Same
 *  semantics as the (now-deleted) H3 variant. */
function cellInPolygonS2(token: string, poly: LonLatPolygon | null): boolean {
    if (!poly) return true
    const ll = S2LatLng.fromPoint(S2CellId.fromToken(token).toPoint())
    return pointInPolygon([ll.lngDegrees, ll.latDegrees], poly)
}

/** `cellInPolygonS2`, memoized per token for one request. The pyramid has one
 *  row per (cell, year), so an all-years read would otherwise redo the
 *  token → point → lat/lng projection once per year-row. */
function polygonTester(poly: LonLatPolygon | null): (token: string) => boolean {
    if (!poly) return () => true
    const memo = new Map<string, boolean>()
    return token => {
        let v = memo.get(token)
        if (v === undefined) {
            v = cellInPolygonS2(token, poly)
            memo.set(token, v)
        }
        return v
    }
}

/** Cell-id ranges at `level` covering a clip polygon.
 *
 *  Covers the polygon's bounding rect, not the polygon itself — the
 *  per-row `cellInPolygonS2` still does the exact clip, so a loose cover
 *  only costs a few extra row groups. */
export function s2RangesForPolygon(poly: LonLatPolygon, level: number, maxCells = 32): S2CellRange[] {
    let latLo = 90, latHi = -90, lngLo = 180, lngHi = -180
    for (const [lng, lat] of poly) {
        if (lat < latLo) latLo = lat
        if (lat > latHi) latHi = lat
        if (lng < lngLo) lngLo = lng
        if (lng > lngHi) lngHi = lng
    }
    const coverer = new S2RegionCoverer()
    coverer.setMaxCells(maxCells)
    coverer.setMinLevel(0)
    // Never cover finer than the level we're querying — `s2RangeForCell`
    // needs each cover cell to be an ancestor of (or equal to) it.
    coverer.setMaxLevel(level)
    const covering = coverer.getCoveringCells(S2LatLngRect.fromLatLng(
        S2LatLng.fromDegrees(latLo, lngLo),
        S2LatLng.fromDegrees(latHi, lngHi),
    ))
    return covering.map(c => s2RangeForCell(s2TokenToId(c.toToken()), level))
}

export { intersectRanges }

/** Handle one `/v1/cells` request. Reads the manifest for
 *  `data_version` + `year_range`, computes S2 token ranges from the
 *  request's shards ∩ clip polygon, then serves from D1 (`CELLS_S2_DB`)
 *  when the request is all-years, falling back to the R2 parquet
 *  pyramid otherwise or on any D1 failure. `format=cols` runs the same
 *  query and re-shapes the result (`toColumnar`). */
export async function handleCellsRequest(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
    db?: D1Database,
    timing?: Timing,
    /** The manifest the caller derived its ETag / cache key from; loaded
     *  here when absent. One snapshot per request, so a cutover mid-request
     *  can't mix two builds. */
    manifest?: Manifest,
): Promise<CellsResponse | CellsColsResponse | CellsColsYearResponse> {
    manifest ??= await loadManifest(bucket, prefix)
    if (req.format === "cols") {
        if (req.labels && req.labels !== "nums") {
            throw new HttpError(400, "format=cols serves counts only (labels must be unset or nums)")
        }
        if (req.group === "year") {
            return queryCellsByYear(bucket, prefix, manifest, req, req.fields ?? COUNT_FIELDS, db, timing)
        }
        const r = await queryCells(bucket, prefix, manifest, { ...req, labels: "nums" }, db, false, timing)
        return toColumnar(r, req.fields ?? COUNT_FIELDS)
    }
    return queryCells(bucket, prefix, manifest, req, db, true, timing)
}

/** Validate the requested level and build the cellid token ranges (shards ∩
 *  clip-polygon cover) at it. Shared by `queryCells` / `queryCellsByYear`. */
function requestRanges(req: CellsRequest): { clipPoly: LonLatPolygon | null; ranges: Array<{ lo: string; hi: string }> } {
    const { cells: requestedShards, res: requestedLevel } = req
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }
    if (requestedLevel < S2_MIN_LEVEL || requestedLevel > S2_MAX_LEVEL) {
        throw new HttpError(400, `s2 level ${requestedLevel} out of range [${S2_MIN_LEVEL}, ${S2_MAX_LEVEL}]`)
    }
    const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null

    // Build cellid ranges at the target level. These drive both the D1
    // `cellid BETWEEN` scan and the parquet row-group pruning, so they
    // want to be as tight as the request allows.
    const shardRanges: S2CellRange[] = []
    for (const shard of requestedShards) {
        const parentId = s2TokenToId(shard)
        const parentLevel = s2LevelOf(parentId)
        if (parentLevel > requestedLevel) {
            throw new HttpError(400,
                `s2 shard level ${parentLevel} finer than requested level ${requestedLevel}`)
        }
        // At parentLevel == requestedLevel, `s2RangeForCell` collapses
        // to a single cell — still a valid (degenerate) range.
        shardRanges.push(s2RangeForCell(parentId, requestedLevel))
    }

    // Tighten to the viewport. NJ is only two l4 cells (`89b`/`89d`), which
    // the client hardcodes as its whole S2 cover — so a shard-derived range
    // spans an entire shard file and prunes *nothing*, and a street-zoom
    // request that misses the D1 fast path decodes all 63 MB of
    // `s2_l19/89d.parquet` (→ CF 1102, "exceeded resource limits"). Covering
    // the clip polygon instead touches ~6 of that file's 549 row groups. The
    // H3 client never hit this — it sent a viewport-sized cover of many small
    // shards; S2's cover is the whole state at every zoom.
    const polyRanges = clipPoly ? s2RangesForPolygon(clipPoly, requestedLevel) : null
    const idRanges = mergeRanges(polyRanges ? intersectRanges(shardRanges, polyRanges) : shardRanges)

    // Tokens, not zero-padded hex. The stored `cellid` (D1 column and parquet
    // value alike) is the S2 token — 16 hex chars with *trailing zeros
    // stripped* — and lex order over stripped tokens is isomorphic to numeric
    // cell-id order, so `BETWEEN` works directly on them. Padding the bounds
    // back to 16 chars breaks that at the low end: a cell sitting exactly on
    // `range_min` (token `89c04532`) sorts *below* the padded bound
    // (`89c0453200000000`) and gets dropped. Invisible while the range covered
    // the whole shard; every tight range above has such a boundary.
    return { clipPoly, ranges: idRanges.map(r => ({ lo: s2IdToToken(r.lo), hi: s2IdToToken(r.hi) })) }
}

/** Per-year counts for one cell. */
type YearCounts = Map<number, Record<CountField, number>>

const zeroCounts = (): Record<CountField, number> => ({
    n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, n_killed: 0, n_killed_ped: 0,
})

/** `format=cols&group=year`: per-(cell, year) counts over the request's year
 *  range, coarsened on *distinct-cell* count against `maxCells` (the same
 *  walk `queryCells` does), as `CellsColsYearResponse`. From D1's `by_year`
 *  column when the tables have it, else (or on any D1 error) the pyramid.
 *  The pyramid's row groups are cellid-sorted with every year inside, so
 *  the year filter never pruned I/O there: an all-years read costs the same
 *  R2 bytes as a 3-year one. */
async function queryCellsByYear(
    bucket: R2Bucket,
    prefix: string,
    manifest: Manifest,
    req: CellsRequest,
    fields: readonly CountField[],
    db: D1Database | undefined,
    timing?: Timing,
): Promise<CellsColsYearResponse> {
    const yearRange = req.yearRange ?? manifest.year_range
    const { clipPoly, ranges } = requestRanges(req)
    let cells = new Map<string, YearCounts>()
    let source: "d1" | "pyramid" = "pyramid"
    // Empty ranges ⇒ viewport disjoint from the shards (see `queryCells`).
    if (ranges.length) {
        const table = d1Table(manifest, req.res)
        let fromD1: Map<string, YearCounts> | null = null
        if (db && byYearAvailable(table)) {
            try {
                const t0 = Date.now()
                fromD1 = await queryCellsS2D1ByYear(db, table, ranges, clipPoly, yearRange, req.severities)
                timing?.add("d1", Date.now() - t0)
            } catch (e) {
                noteByYearFailure(table, e)
            }
        }
        if (fromD1) {
            cells = fromD1
            source = "d1"
        } else {
            cells = await queryPyramidS2ByYear(
                bucket, prefix, manifest, req.res, req.cells, yearRange, req.severities, clipPoly, ranges, timing,
            )
        }
    }
    timing?.note("src", source)
    let level = req.res
    const t0 = Date.now()
    const rowCount = (m: Map<string, YearCounts>) => { let n = 0; for (const ys of m.values()) n += ys.size; return n }
    // Coarsen on distinct cells (as `queryCells`) *and* on (cell, year) rows:
    // a wide dense view is up to ~25 rows per cell, so `maxCells` alone
    // doesn't bound the payload.
    while (level > S2_MIN_LEVEL && (
        (req.maxCells != null && cells.size > req.maxCells)
        || rowCount(cells) > (req.maxRows ?? DEFAULT_MAX_YEAR_ROWS)
    )) {
        level--
        cells = coarsenYearCells(cells, level)
    }
    timing?.add("coarsen", Date.now() - t0)
    return toColumnarByYear(
        { res: level, year_range: yearRange, data_version: manifest.data_version, source, labels: "nums" },
        cells, fields,
    )
}

/** Roll per-(cell, year) counts up to their `toLevel` parents. */
export function coarsenYearCells(cells: Map<string, YearCounts>, toLevel: number): Map<string, YearCounts> {
    const out = new Map<string, YearCounts>()
    for (const [token, years] of cells) {
        const parent = s2IdToToken(s2Parent(s2TokenToId(token), toLevel))
        let py = out.get(parent)
        if (!py) { py = new Map(); out.set(parent, py) }
        for (const [year, c] of years) {
            let pc = py.get(year)
            if (!pc) { pc = zeroCounts(); py.set(year, pc) }
            for (const f of COUNT_FIELDS) pc[f] += c[f]
        }
    }
    return out
}

/** Per-(cell, year) map → `CellsColsYearResponse`. */
export function toColumnarByYear(
    envelope: Omit<CellsResponse, "cells">,
    cells: Map<string, YearCounts>,
    fields: readonly CountField[] = COUNT_FIELDS,
): CellsColsYearResponse {
    const tokens = [...cells.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const nyears: number[] = []
    const year: number[] = []
    const cols: CellsColsYearResponse["cols"] = { cellid: encodeTokens(tokens), nyears, year }
    const out = fields.map(f => { const a: number[] = []; cols[f] = a; return [f, a] as const })
    for (const t of tokens) {
        const ys = cells.get(t)!
        const sorted = [...ys.keys()].sort((a, b) => a - b)
        nyears.push(sorted.length)
        for (const y of sorted) {
            year.push(y)
            const c = ys.get(y)!
            for (const [f, a] of out) a.push(c[f])
        }
    }
    return {
        ...envelope, format: "cols", group: "year", cellid_enc: "prefix-hex1",
        n: tokens.length, n_rows: year.length, cols,
    }
}

async function queryCells(
    bucket: R2Bucket,
    prefix: string,
    manifest: Manifest,
    req: CellsRequest,
    db: D1Database | undefined,
    fatalYears: boolean,
    timing?: Timing,
): Promise<CellsResponse> {
    const { cells: requestedShards, res: requestedLevel, maxCells } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities
    const labels = req.labels ?? "full"
    const labelMaxCells = req.labelMaxCells ?? DEFAULT_LABEL_MAX_CELLS
    const { clipPoly, ranges } = requestRanges(req)

    // Viewport disjoint from the requested shards ⇒ nothing to return. Bail
    // before the queries: an empty range list means "no filter" to both of
    // them, which would scan the whole shard instead of none of it.
    if (!ranges.length) {
        return {
            res: requestedLevel, year_range: yearRange,
            data_version: manifest.data_version, source: "d1", cells: [],
        }
    }

    // D1 fast path: `cells_s2_l{level}` — one indexed lex-range scan.
    // Falls through to the parquet path on any failure (binding
    // absent, table missing, `by_year` missing, oversized result).
    // A *severity* filter does not need the parquet: severity is pure
    // column-selection (the rollup stores `n_fatal` / `n_inj_ped` /
    // `n_inj_other` / `n_pdo` separately, and both query paths just gate
    // which counters accumulate), so D1 can serve it. Only a *year*
    // sub-range needs per-year counts: the rollup's `by_year` column (when
    // this table set has it — see `byYearAvailable`), else the pyramid.
    const coversAllYears = req.yearRange == null
        || (req.yearRange[0] <= manifest.year_range[0] && req.yearRange[1] >= manifest.year_range[1])
    const table = d1Table(manifest, requestedLevel)
    //
    // `labels=nums` used to *disqualify* this path, which made the one
    // existing byte-saving lever cost 3-20× in latency (measured
    // 2026-08-22: statewide-mid l14 945ms full → 10.5s nums; Hudson l17
    // 3.0s → 21.9s). Nothing about dropping four columns needs the
    // parquet, so `nums` rides the same scan and just selects less.
    if (db && labels !== "only" && (coversAllYears || byYearAvailable(table))) {
        try {
            const t0 = Date.now()
            let cells = await queryCellsS2D1(
                db, table, ranges, clipPoly, sevSet, labels, fatalYears, coversAllYears ? undefined : yearRange,
            )
            const t1 = Date.now()
            let level = requestedLevel
            while (maxCells != null && cells.length > maxCells && level > S2_MIN_LEVEL) {
                level--
                cells = coarsenCellsS2(cells, level)
            }
            const served = servedLabels(labels, cells, labelMaxCells)
            const t2 = Date.now()
            timing?.note("src", "d1")
            timing?.add("d1", t1 - t0)
            timing?.add("coarsen", t2 - t1)
            timing?.count("cells", cells.length)
            console.log(`[timing] s2 l${requestedLevel} D1${coversAllYears ? "" : ` years=${yearRange.join("-")}`} labels=${labels}→${served} ranges=${ranges.length} cells=${cells.length}: d1=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
            return { res: level, year_range: yearRange, data_version: manifest.data_version, source: "d1", labels: served, cells }
        } catch (e) {
            if (coversAllYears) console.error(`S2 D1 path failed (level ${requestedLevel}), falling back to parquet:`, e)
            else noteByYearFailure(table, e)
        }
    }

    const t0 = Date.now()
    let cells = await queryPyramidS2(
        bucket, prefix, manifest, requestedLevel, requestedShards, yearRange, sevSet,
        clipPoly, ranges, labels, timing,
    )
    const t1 = Date.now()
    let level = requestedLevel
    // In-worker coarsening. S2's exact-tiling property means sums roll up
    // losslessly (the whole point of migrating off H3, whose boundary
    // triangles made a parent ≠ the union of its children).
    while (labels !== "only" && maxCells != null && cells.length > maxCells && level > S2_MIN_LEVEL) {
        level--
        cells = coarsenCellsS2(cells, level)
    }
    const served = servedLabels(labels, cells, labelMaxCells)
    const t2 = Date.now()
    timing?.note("src", "pyramid")
    timing?.add("coarsen", t2 - t1)
    timing?.count("cells", cells.length)
    console.log(`[timing] s2 l${requestedLevel} labels=${labels}→${served} shards=${requestedShards.length} ranges=${ranges.length} cells=${cells.length}: pyramid=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
    return {
        res: level,
        year_range: yearRange,
        data_version: manifest.data_version,
        source: "pyramid",
        labels: served,
        cells,
    }
}

/** Per-(cell, year) pyramid read for `queryCellsByYear`: same shards, ranges,
 *  clip, and severity gating as `queryPyramidS2`, but keeps the year axis
 *  (and only the requested severities' counters). */
async function queryPyramidS2ByYear(
    bucket: R2Bucket,
    prefix: string,
    manifest: Manifest,
    level: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
    tokenRanges: Array<{ lo: string; hi: string }>,
    timing?: Timing,
): Promise<Map<string, YearCounts>> {
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const inPoly = polygonTester(clipPoly)
    const cellidRangeOr = { $or: tokenRanges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) }
    const filter = { $and: [{ year: { $gte: yearRange[0], $lte: yearRange[1] } }, cellidRangeOr] }
    const cols = ["cellid", "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "n_killed", "n_killed_ped"]
    const results = await Promise.all(shards.map(s => {
        const key = pyramidShardKey(manifest, prefix, level, s)
        if (!key) return null
        return readParquetFromR2<PyramidRowS2>(bucket, key, { columns: cols, filter, missingOk: true, timing })
            .catch(e => { console.error(`s2 pyramid ${key} read failed:`, e); return null })
    }))
    const out = new Map<string, YearCounts>()
    for (const rows of results) {
        if (!rows) continue
        for (const row of rows) {
            const n_fatal = wantF ? row.n_fatal ?? 0 : 0
            const n_inj_ped = wantI ? row.n_inj_ped ?? 0 : 0
            const n_inj_other = wantI ? row.n_inj_other ?? 0 : 0
            const n_pdo = wantP ? row.n_pdo ?? 0 : 0
            if (!(n_fatal > 0 || n_inj_ped > 0 || n_inj_other > 0 || n_pdo > 0)) continue
            const token = row.cellid
            if (!inPoly(token)) continue
            let ys = out.get(token)
            if (!ys) { ys = new Map(); out.set(token, ys) }
            let c = ys.get(row.year)
            if (!c) { c = zeroCounts(); ys.set(row.year, c) }
            c.n_fatal += n_fatal
            c.n_inj_ped += n_inj_ped
            c.n_inj_other += n_inj_other
            c.n_pdo += n_pdo
            c.n_vehs += row.n_vehs ?? 0
            c.n_killed += row.n_killed ?? 0
            c.n_killed_ped += row.n_killed_ped ?? 0
        }
    }
    timing?.count("cells", out.size)
    return out
}

/** S2 analog of `queryPyramid`. Reads `s2_pyramid/s2_l{level}/{token}.parquet`
 *  for each requested shard, applies row-group pruning via the
 *  `cellid BETWEEN` ranges the caller computed, aggregates rows across
 *  year (drops the year filter's row multiplication), and returns
 *  one `CellOut` per unique cell.
 *
 *  Cell keys in the output go in the `cellid` field (an S2 token; it was
 *  the H3-era `h3` until Phase 4b). */
async function queryPyramidS2(
    bucket: R2Bucket,
    prefix: string,
    manifest: Manifest,
    level: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
    tokenRanges: Array<{ lo: string; hi: string }>,
    labels: "full" | "nums" | "only" = "full",
    timing?: Timing,
): Promise<CellOut[]> {
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()
    const inPoly = polygonTester(clipPoly)

    // Parquet column names (from `njdot/cli/cells.py` `_build_pyramid_level_s2`):
    // cellid TEXT (S2 token), year INT, count cols INT, sld_name TEXT, ...
    // Row-group pruning uses `$or` of `cellid` bounds.
    const cellidRangeOr = tokenRanges.length
        ? { $or: tokenRanges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) }
        : null

    if (labels === "only") {
        const cols = ["cellid", "sld_name", "cross_sld_name", "mun", "county"]
        const results = await Promise.all(shards.map(async s => {
            const key = pyramidShardKey(manifest, prefix, level, s)
            if (!key) return null
            try {
                return await readParquetFromR2<PyramidRowS2>(
                    bucket, key,
                    { columns: cols, filter: cellidRangeOr ?? undefined, missingOk: true, timing },
                )
            } catch (e) {
                console.error(`s2 pyramid ${key} labels read failed:`, e)
                return null
            }
        }))
        for (const rows of results) {
            if (!rows) continue
            for (const row of rows) {
                const token = row.cellid as string
                if (out.has(token)) continue
                if (!row.sld_name && !row.cross_sld_name && !row.mun && !row.county) continue
                if (!inPoly(token)) continue
                const c: CellOut = { cellid: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, n_killed: 0, n_killed_ped: 0 }
                if (row.sld_name) c.sld_name = row.sld_name
                if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
                if (row.mun) c.mun = row.mun
                if (row.county) c.county = row.county
                out.set(token, c)
            }
        }
        return [...out.values()]
    }

    const cols = labels === "nums"
        ? ["cellid", "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "n_killed", "n_killed_ped"]
        : ["cellid", "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "n_killed", "n_killed_ped", "sld_name", "cross_sld_name", "mun", "county"]

    const yearFilter = { year: { $gte: yearRange[0], $lte: yearRange[1] } }
    const filter = cellidRangeOr ? { $and: [yearFilter, cellidRangeOr] } : yearFilter

    const results = await Promise.all(shards.map(async s => {
        const key = pyramidShardKey(manifest, prefix, level, s)
        if (!key) return null
        try {
            return await readParquetFromR2<PyramidRowS2>(
                bucket, key,
                { columns: cols, filter, missingOk: true, timing },
            )
        } catch (e) {
            console.error(`s2 pyramid ${key} read failed:`, e)
            return null
        }
    }))
    for (const rows of results) {
        if (!rows) continue
        for (const row of rows) {
            const token = row.cellid as string
            if (!inPoly(token)) continue
            let c = out.get(token)
            if (!c) {
                c = { cellid: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, n_killed: 0, n_killed_ped: 0 }
                if (row.sld_name) c.sld_name = row.sld_name
                if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
                if (row.mun) c.mun = row.mun
                if (row.county) c.county = row.county
                out.set(token, c)
            }
            if (wantF) {
                c.n_fatal += row.n_fatal ?? 0
                if ((row.n_fatal ?? 0) > 0) {
                    ;(c.fatal_years ??= []).push(row.year)
                }
            }
            if (wantI) { c.n_inj_ped += row.n_inj_ped ?? 0; c.n_inj_other += row.n_inj_other ?? 0 }
            if (wantP) c.n_pdo += row.n_pdo ?? 0
            c.n_vehs += row.n_vehs ?? 0
            // Deaths are severity-blind (a cell total, like n_vehs), so the two
            // query paths agree cell-for-cell regardless of the severity filter.
            c.n_killed += row.n_killed ?? 0
            c.n_killed_ped += row.n_killed_ped ?? 0
        }
    }
    const cells: CellOut[] = []
    for (const c of out.values()) {
        const keep =
            (wantF && c.n_fatal > 0) ||
            (wantI && (c.n_inj_ped > 0 || c.n_inj_other > 0)) ||
            (wantP && c.n_pdo > 0)
        if (!keep) continue
        c.fatal_years?.sort((a, b) => a - b)
        cells.push(c)
    }
    return cells
}

/** D1 fast path for the S2 default (all-years, all-severity) query.
 *  One indexed lex-range scan against `cells_s2_l{level}`. `cellid` is
 *  stored as TEXT — S2 tokens are natively strings, so the range
 *  predicate is a direct string comparison (no int64 encoding gymnastics
 *  of the kind the H3 rollup needed). Lex order
 *  on 16-char zero-padded tokens matches S2's Hilbert-curve order,
 *  matching the ranges produced by `s2-range.ts`. */
async function queryCellsS2D1(
    db: D1Database,
    /** `cells_s2_l{level}`, or this build's versioned equivalent (`d1Table`). */
    table: string,
    tokenRanges: Array<{ lo: string; hi: string }>,
    clipPoly: LonLatPolygon | null,
    severities?: Set<"f" | "i" | "p">,
    labels: "full" | "nums" = "full",
    /** Select + parse `fatal_years`. Off for `format=cols`, which never
     *  ships it. */
    fatalYears = true,
    /** Year sub-range: sum the `by_year` entries in it instead of reading
     *  the all-years columns. */
    yearRange?: [number, number],
): Promise<CellOut[]> {
    // Severity gating mirrors `queryPyramidS2` exactly — same counters, same
    // "drop cells with no hit in a requested severity" rule — so the two
    // paths agree cell-for-cell on a severity-filtered request.
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const where = tokenRanges.length
        ? tokenRanges.map(r => `(cellid BETWEEN '${r.lo}' AND '${r.hi}')`).join(" OR ")
        : "1=1"
    const cols = yearRange
        ? ["cellid", "by_year"]
        : ["cellid", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "n_killed", "n_killed_ped"]
    if (fatalYears && !yearRange) cols.push("fatal_years")
    if (labels === "full") cols.push(...LABEL_KEYS)
    const sql = `SELECT ${cols.join(", ")} FROM ${table} WHERE ${where}`
    const { results } = await db.prepare(sql).all<{
        cellid: string
        n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs: number
        n_killed: number; n_killed_ped: number
        fatal_years: string | null
        by_year?: string | null
        sld_name?: string | null; cross_sld_name?: string | null; mun?: string | null; county?: string | null
    }>()
    const sums = new Int32Array(N_BY_YEAR)
    const cells: CellOut[] = []
    for (const row of results) {
        let rangeFatalYears: number[] | null = null
        if (yearRange) {
            // Rows mid-migration (or a bad build) have no per-year counts;
            // fail the whole request over to the pyramid rather than serve a
            // partial answer.
            if (row.by_year == null) throw new Error(`${table}: NULL by_year for cell ${row.cellid}`)
            rangeFatalYears = sumByYear(row.by_year, yearRange[0], yearRange[1], sums)
            row.n_fatal = sums[BY_YEAR_IDX.n_fatal]
            row.n_inj_ped = sums[BY_YEAR_IDX.n_inj_ped]
            row.n_inj_other = sums[BY_YEAR_IDX.n_inj_other]
            row.n_pdo = sums[BY_YEAR_IDX.n_pdo]
            row.n_vehs = sums[BY_YEAR_IDX.n_vehs]
            row.n_killed = sums[BY_YEAR_IDX.n_killed]
            row.n_killed_ped = sums[BY_YEAR_IDX.n_killed_ped]
        }
        const n_fatal = wantF ? row.n_fatal : 0
        const n_inj_ped = wantI ? row.n_inj_ped : 0
        const n_inj_other = wantI ? row.n_inj_other : 0
        const n_pdo = wantP ? row.n_pdo : 0
        // Nothing to render on a severity-colored map. Also drops the handful
        // of cells whose crashes all carry a *blank* severity in the source
        // (~13 statewide at l18) — the parquet path drops them too.
        if (!(n_fatal > 0 || n_inj_ped > 0 || n_inj_other > 0 || n_pdo > 0)) continue
        if (!cellInPolygonS2(row.cellid, clipPoly)) continue
        const c: CellOut = {
            cellid: row.cellid,
            n_fatal, n_inj_ped, n_inj_other, n_pdo,
            n_vehs: row.n_vehs,  // severity-blind, same as the parquet path
            n_killed: row.n_killed ?? 0,
            n_killed_ped: row.n_killed_ped ?? 0,
        }
        if (rangeFatalYears) {
            if (fatalYears && wantF && rangeFatalYears.length) c.fatal_years = rangeFatalYears
        } else if (wantF && row.fatal_years) {
            try {
                const parsed = JSON.parse(row.fatal_years)
                if (Array.isArray(parsed) && parsed.length) c.fatal_years = parsed as number[]
            } catch { /* ignore — malformed rollup */ }
        }
        if (row.sld_name) c.sld_name = row.sld_name
        if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
        if (row.mun) c.mun = row.mun
        if (row.county) c.county = row.county
        cells.push(c)
    }
    return cells
}

/** D1 read for `format=cols&group=year`: each cell's in-range `by_year`
 *  entries become its per-year rows, with the pyramid path's rules — only
 *  the requested severities' counters, and only years with ≥1 crash of a
 *  requested severity (`queryPyramidS2ByYear`). */
async function queryCellsS2D1ByYear(
    db: D1Database,
    table: string,
    tokenRanges: Array<{ lo: string; hi: string }>,
    clipPoly: LonLatPolygon | null,
    yearRange: [number, number],
    severities?: Set<"f" | "i" | "p">,
): Promise<Map<string, YearCounts>> {
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const where = tokenRanges.map(r => `(cellid BETWEEN '${r.lo}' AND '${r.hi}')`).join(" OR ")
    const { results } = await db.prepare(`SELECT cellid, by_year FROM ${table} WHERE ${where}`)
        .all<{ cellid: string; by_year: string | null }>()
    const [y0, y1] = yearRange
    const out = new Map<string, YearCounts>()
    for (const { cellid, by_year } of results) {
        if (by_year == null) throw new Error(`${table}: NULL by_year for cell ${cellid}`)
        let ys: YearCounts | null = null
        forEachYear(by_year, (year, c) => {
            if (year < y0 || year > y1) return
            const n_fatal = wantF ? c[BY_YEAR_IDX.n_fatal] : 0
            const n_inj_ped = wantI ? c[BY_YEAR_IDX.n_inj_ped] : 0
            const n_inj_other = wantI ? c[BY_YEAR_IDX.n_inj_other] : 0
            const n_pdo = wantP ? c[BY_YEAR_IDX.n_pdo] : 0
            if (!(n_fatal > 0 || n_inj_ped > 0 || n_inj_other > 0 || n_pdo > 0)) return
            ys ??= new Map()
            ys.set(year, {
                n_fatal, n_inj_ped, n_inj_other, n_pdo,
                n_vehs: c[BY_YEAR_IDX.n_vehs],
                n_killed: c[BY_YEAR_IDX.n_killed],
                n_killed_ped: c[BY_YEAR_IDX.n_killed_ped],
            })
        })
        // Clip after the (cheap) year/severity filter: most rows of a narrow
        // range drop there, before the token → lat/lng projection.
        if (ys && cellInPolygonS2(cellid, clipPoly)) out.set(cellid, ys)
    }
    return out
}

/** D1 tables known to lack `by_year` (→ `now + MANIFEST_TTL_MS`). A table
 *  set imported before `specs/cells-d1-years.md` has no such column; rather
 *  than fail a D1 round trip per year-filtered request until the new set is
 *  activated, skip D1 for that table for a minute (the manifest's re-read
 *  interval, which is also how fast a new table set goes live). */
const noByYear = new Map<string, number>()

function byYearAvailable(table: string, now: number = Date.now()): boolean {
    const until = noByYear.get(table)
    if (until == null) return true
    if (now < until) return false
    noByYear.delete(table)
    return true
}

/** Log a failed `by_year` read; remember a missing column (see `noByYear`). */
function noteByYearFailure(table: string, e: unknown, now: number = Date.now()): void {
    if (/no such column: by_year/.test(String(e))) {
        noByYear.set(table, now + MANIFEST_TTL_MS)
        console.log(`${table} has no by_year column; serving year ranges from the pyramid`)
    } else {
        console.error(`S2 D1 by_year read failed (${table}), falling back to parquet:`, e)
    }
}

/** Test-only: forget which tables lack `by_year`. */
export function _resetByYearCache(): void {
    noByYear.clear()
}

/** S2 analog of `coarsenCells` — rolls fine-level cells up to a coarser
 *  target level via the S2 parent walk. Lossless because S2 children
 *  exactly tile their parents (unlike H3's boundary-triangle drift). */
export function coarsenCellsS2(cells: CellOut[], toLevel: number): CellOut[] {
    if (cells.length === 0) return cells
    const parents = new Map<string, CellOut>()
    for (const c of cells) {
        const childId = s2TokenToId(c.cellid)
        const parentId = s2Parent(childId, toLevel)
        const parentToken = s2IdToToken(parentId)
        let p = parents.get(parentToken)
        if (!p) {
            p = {
                cellid: parentToken,
                n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0,
                n_killed: 0, n_killed_ped: 0,
            }
            // Labels drop on coarsen — parent cell doesn't have a single
            // road label. Client tooltip degrades gracefully.
            parents.set(parentToken, p)
        }
        p.n_fatal += c.n_fatal
        p.n_inj_ped += c.n_inj_ped
        p.n_inj_other += c.n_inj_other
        p.n_pdo += c.n_pdo
        p.n_vehs += c.n_vehs
        p.n_killed += c.n_killed
        p.n_killed_ped += c.n_killed_ped
        if (c.fatal_years && c.fatal_years.length) {
            (p.fatal_years ??= []).push(...c.fatal_years)
        }
    }
    for (const p of parents.values()) {
        if (p.fatal_years) p.fatal_years = [...new Set(p.fatal_years)].sort((a, b) => a - b)
    }
    return [...parents.values()]
}

export class HttpError extends Error {
    status: number
    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

/** Parse + validate query string into a CellsRequest. */
export function parseCellsRequest(url: URL): CellsRequest {
    // `grid` is vestigial: S2 is the only grid (h3-removal Phase 2). It's
    // still *parsed* rather than ignored so that a stale client asking for
    // `grid=h3` gets a visible 400 instead of a body full of S2 tokens it
    // would feed to `cellToLatLng` and render as garbage.
    const g = url.searchParams.get("grid")
    if (g != null && g !== "s2") {
        throw new HttpError(400, `grid '${g}' is no longer supported — s2 is the only grid`)
    }

    const cellsStr = url.searchParams.get("cells")
    if (!cellsStr) throw new HttpError(400, "cells is required (comma-separated cell tokens)")
    const cells = cellsStr.split(",").map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length === 0) throw new HttpError(400, "cells must list ≥1 shard")
    // S2 tokens are lowercase hex with trailing zeros stripped (so length
    // 1-16), or the literal `"X"` for cell id 0.
    if (cells.some(c => c !== "X" && !/^[0-9a-f]{1,16}$/.test(c))) {
        throw new HttpError(400, "cells must be lowercase hex S2 tokens (or 'X' for id 0)")
    }

    const resStr = url.searchParams.get("res")
    if (!resStr) throw new HttpError(400, "res is required")
    const res = parseInt(resStr, 10)
    if (!Number.isFinite(res)) throw new HttpError(400, "res must be an integer")

    let yearRange: [number, number] | undefined
    const ys = url.searchParams.get("years")
    if (ys) {
        const m = /^(\d{4})-(\d{4})$/.exec(ys)
        if (!m) throw new HttpError(400, "years must look like YYYY-YYYY")
        yearRange = [parseInt(m[1], 10), parseInt(m[2], 10)]
        if (yearRange[0] > yearRange[1]) throw new HttpError(400, "years[0] > years[1]")
    }

    let severities: Set<"f" | "i" | "p"> | undefined
    // Accept both `severity` (singular) and `severities` (plural). Historical
    // clients use the plural; `severity` is what a hand-written URL typically
    // tries and was previously dropped silently. Singular wins on conflict.
    const ss = url.searchParams.get("severity") ?? url.searchParams.get("severities")
    if (ss) {
        severities = new Set()
        for (const ch of ss) {
            if (ch !== "f" && ch !== "i" && ch !== "p") {
                throw new HttpError(400, `unknown severity '${ch}'`)
            }
            severities.add(ch)
        }
    }

    // `polygon` query param: GeoJSON-style `lon,lat,lon,lat,...` flat
    // list, ≥3 vertices. Compact wire format keeps it under typical URL
    // length limits for county/muni outlines (a few hundred verts).
    let clipPolygon: LonLatPolygon | undefined
    const ps = url.searchParams.get("polygon")
    if (ps) {
        const nums = ps.split(",").map(Number)
        if (nums.length < 6 || nums.length % 2 !== 0 || nums.some(x => Number.isNaN(x))) {
            throw new HttpError(400, "polygon must be ≥3 lon,lat pairs")
        }
        const ring: LonLatPolygon = []
        for (let i = 0; i < nums.length; i += 2) ring.push([nums[i], nums[i + 1]])
        clipPolygon = ring
    }

    let maxCells: number | undefined
    const mc = url.searchParams.get("maxCells")
    if (mc) {
        const n = parseInt(mc, 10)
        if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, "maxCells must be a positive integer")
        maxCells = n
    }

    let shardRes: number | undefined
    const sr = url.searchParams.get("shard_res")
    if (sr) {
        const n = parseInt(sr, 10)
        if (!Number.isFinite(n) || n < S2_MIN_LEVEL || n > S2_MAX_LEVEL) {
            throw new HttpError(400, `shard_res must be in [${S2_MIN_LEVEL}, ${S2_MAX_LEVEL}]`)
        }
        shardRes = n
    }

    let labels: "full" | "nums" | "only" | undefined
    const lb = url.searchParams.get("labels")
    if (lb) {
        if (lb !== "full" && lb !== "nums" && lb !== "only") {
            throw new HttpError(400, "labels must be one of full|nums|only")
        }
        labels = lb
    }

    let labelMaxCells: number | undefined
    const lmc = url.searchParams.get("label_max_cells")
    if (lmc) {
        const n = parseInt(lmc, 10)
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "label_max_cells must be a non-negative integer")
        labelMaxCells = n
    }

    let format: "rows" | "cols" | undefined
    const fm = url.searchParams.get("format")
    if (fm) {
        if (fm !== "rows" && fm !== "cols") throw new HttpError(400, "format must be one of rows|cols")
        format = fm
    }

    let fields: CountField[] | undefined
    const fs = url.searchParams.get("fields")
    if (fs != null) {
        if (format !== "cols") throw new HttpError(400, "fields requires format=cols")
        const names = fs.split(",").map(f => f.trim()).filter(f => f.length > 0)
        if (!names.length) throw new HttpError(400, "fields must list ≥1 count column")
        for (const f of names) {
            if (!(COUNT_FIELDS as readonly string[]).includes(f)) {
                throw new HttpError(400, `unknown field '${f}' (expected one of ${COUNT_FIELDS.join("|")})`)
            }
        }
        if (new Set(names).size !== names.length) throw new HttpError(400, "fields must not repeat")
        fields = names as CountField[]
    }

    let group: "year" | undefined
    const gp = url.searchParams.get("group")
    if (gp != null) {
        if (gp !== "year") throw new HttpError(400, "group must be 'year'")
        if (format !== "cols") throw new HttpError(400, "group requires format=cols")
        group = gp
    }

    let maxRows: number | undefined
    const mr = url.searchParams.get("max_rows")
    if (mr != null) {
        const n = parseInt(mr, 10)
        if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, "max_rows must be a positive integer")
        if (group !== "year") throw new HttpError(400, "max_rows requires group=year")
        maxRows = n
    }
    return { cells, res, yearRange, severities, clipPolygon, maxCells, shardRes, labels, labelMaxCells, format, fields, group, maxRows }
}
