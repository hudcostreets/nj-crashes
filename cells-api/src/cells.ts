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
 *  - **D1** (`cells_s2_l{level}`, all-years requests): one indexed
 *    `cellid BETWEEN` lex-range scan returning counts (+ labels).
 *  - **Parquet pyramid** (`s2_pyramid/s2_l{level}/{token}.parquet`):
 *    year-filterable, row-group-pruned by the same ranges. Also the
 *    fallback whenever the D1 path errors.
 *
 *  Response shape:
 *
 *      {
 *        res: number,                    // the level actually served
 *        year_range: [number, number],
 *        data_version: string,
 *        source: "pyramid" | "d1",
 *        labels: "full" | "nums" | "only",
 *        cells: [{ cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs }]
 *      }
 *
 *  The cell key rode a vestigial `h3` wire field until h3-removal Phase
 *  4b renamed it to `cellid` (worker + client moved together).
 */
import { S2CellId, S2LatLng, S2LatLngRect, S2RegionCoverer } from "nodes2ts"
import { loadManifest } from "./manifest"
import { readParquetFromR2 } from "./parquet"
import {
    type S2CellRange,
    mergeRanges,
    s2IdToToken,
    s2LevelOf,
    s2Parent,
    s2RangeForCell,
    s2TokenToId,
} from "./s2-range"

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
}

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

/** Pairwise intersection of two range sets. Both are small (≤ a few
 *  dozen), so the quadratic scan is cheaper than sorting. */
export function intersectRanges(a: S2CellRange[], b: S2CellRange[]): S2CellRange[] {
    const out: S2CellRange[] = []
    for (const x of a) {
        for (const y of b) {
            const lo = x.lo > y.lo ? x.lo : y.lo
            const hi = x.hi < y.hi ? x.hi : y.hi
            if (lo <= hi) out.push({ lo, hi })
        }
    }
    return out
}

/** Handle one `/v1/cells` request. Reads the manifest for
 *  `data_version` + `year_range`, computes S2 token ranges from the
 *  request's shards ∩ clip polygon, then serves from D1 (`CELLS_S2_DB`)
 *  when the request is all-years, falling back to the R2 parquet
 *  pyramid otherwise or on any D1 failure. */
export async function handleCellsRequest(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
    db?: D1Database,
): Promise<CellsResponse> {
    const manifest = await loadManifest(bucket, prefix)
    const { cells: requestedShards, res: requestedLevel, maxCells } = req
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }
    if (requestedLevel < S2_MIN_LEVEL || requestedLevel > S2_MAX_LEVEL) {
        throw new HttpError(400, `s2 level ${requestedLevel} out of range [${S2_MIN_LEVEL}, ${S2_MAX_LEVEL}]`)
    }
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities
    // Clip polygon plumbing — currently disabled for S2 (see
    // `cellInPolygonS2`); passes through so phase 4e can turn it on.
    const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null
    const labels = req.labels ?? "full"
    const labelMaxCells = req.labelMaxCells ?? DEFAULT_LABEL_MAX_CELLS

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

    // Viewport disjoint from the requested shards ⇒ nothing to return. Bail
    // before the queries: an empty range list means "no filter" to both of
    // them, which would scan the whole shard instead of none of it.
    if (!idRanges.length) {
        return {
            res: requestedLevel, year_range: yearRange,
            data_version: manifest.data_version, source: "d1", cells: [],
        }
    }

    // Tokens, not zero-padded hex. The stored `cellid` (D1 column and parquet
    // value alike) is the S2 token — 16 hex chars with *trailing zeros
    // stripped* — and lex order over stripped tokens is isomorphic to numeric
    // cell-id order, so `BETWEEN` works directly on them. Padding the bounds
    // back to 16 chars breaks that at the low end: a cell sitting exactly on
    // `range_min` (token `89c04532`) sorts *below* the padded bound
    // (`89c0453200000000`) and gets dropped. Invisible while the range covered
    // the whole shard; every tight range above has such a boundary.
    const ranges = idRanges.map(r => ({ lo: s2IdToToken(r.lo), hi: s2IdToToken(r.hi) }))

    // D1 fast path: default (all-years, all-severity, full-labels)
    // query hits `cells_s2_l{level}` — one indexed lex-range scan.
    // Falls through to the parquet path on any failure (binding
    // absent, table missing, oversized result).
    // A *severity* filter does not need the parquet: severity is pure
    // column-selection (the rollup stores `n_fatal` / `n_inj_ped` /
    // `n_inj_other` / `n_pdo` separately, and both query paths just gate
    // which counters accumulate), so D1 can serve it. Only a *year*
    // sub-range genuinely needs the per-year rows the pyramid has and the
    // rollup doesn't.
    const coversAllYears = req.yearRange == null
        || (req.yearRange[0] <= manifest.year_range[0] && req.yearRange[1] >= manifest.year_range[1])
    //
    // `labels=nums` used to *disqualify* this path, which made the one
    // existing byte-saving lever cost 3-20× in latency (measured
    // 2026-08-22: statewide-mid l14 945ms full → 10.5s nums; Hudson l17
    // 3.0s → 21.9s). Nothing about dropping four columns needs the
    // parquet, so `nums` rides the same scan and just selects less.
    if (db && coversAllYears && labels !== "only") {
        try {
            const t0 = Date.now()
            let cells = await queryCellsS2D1(db, requestedLevel, ranges, clipPoly, sevSet, labels)
            const t1 = Date.now()
            let level = requestedLevel
            while (maxCells != null && cells.length > maxCells && level > S2_MIN_LEVEL) {
                level--
                cells = coarsenCellsS2(cells, level)
            }
            const served = servedLabels(labels, cells, labelMaxCells)
            const t2 = Date.now()
            console.log(`[timing] s2 l${requestedLevel} D1 labels=${labels}→${served} ranges=${ranges.length} cells=${cells.length}: d1=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
            return { res: level, year_range: yearRange, data_version: manifest.data_version, source: "d1", labels: served, cells }
        } catch (e) {
            console.error(`S2 D1 path failed (level ${requestedLevel}), falling back to parquet:`, e)
        }
    }

    const t0 = Date.now()
    let cells = await queryPyramidS2(
        bucket, prefix, requestedLevel, requestedShards, yearRange, sevSet,
        clipPoly, ranges, labels,
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
    level: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
    tokenRanges: Array<{ lo: string; hi: string }>,
    labels: "full" | "nums" | "only" = "full",
): Promise<CellOut[]> {
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()

    // Parquet column names (from `njdot/cli/cells.py` `_build_pyramid_level_s2`):
    // cellid TEXT (S2 token), year INT, count cols INT, sld_name TEXT, ...
    // Row-group pruning uses `$or` of `cellid` bounds.
    const cellidRangeOr = tokenRanges.length
        ? { $or: tokenRanges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) }
        : null
    const subdir = `s2_pyramid/s2_l${level}`

    if (labels === "only") {
        const cols = ["cellid", "sld_name", "cross_sld_name", "mun", "county"]
        const results = await Promise.all(shards.map(async s => {
            try {
                return await readParquetFromR2<PyramidRowS2>(
                    bucket, `${prefix}/${subdir}/${s}.parquet`,
                    { columns: cols, filter: cellidRangeOr ?? undefined, missingOk: true },
                )
            } catch (e) {
                console.error(`s2 pyramid ${subdir}/${s} labels read failed:`, e)
                return null
            }
        }))
        for (const rows of results) {
            if (!rows) continue
            for (const row of rows) {
                const token = row.cellid as string
                if (out.has(token)) continue
                if (!row.sld_name && !row.cross_sld_name && !row.mun && !row.county) continue
                if (!cellInPolygonS2(token, clipPoly)) continue
                const c: CellOut = { cellid: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
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
        ? ["cellid", "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"]
        : ["cellid", "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "sld_name", "cross_sld_name", "mun", "county"]

    const yearFilter = { year: { $gte: yearRange[0], $lte: yearRange[1] } }
    const filter = cellidRangeOr ? { $and: [yearFilter, cellidRangeOr] } : yearFilter

    const results = await Promise.all(shards.map(async s => {
        try {
            return await readParquetFromR2<PyramidRowS2>(
                bucket, `${prefix}/${subdir}/${s}.parquet`,
                { columns: cols, filter, missingOk: true },
            )
        } catch (e) {
            console.error(`s2 pyramid ${subdir}/${s} read failed:`, e)
            return null
        }
    }))
    for (const rows of results) {
        if (!rows) continue
        for (const row of rows) {
            const token = row.cellid as string
            if (!cellInPolygonS2(token, clipPoly)) continue
            let c = out.get(token)
            if (!c) {
                c = { cellid: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
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
    level: number,
    tokenRanges: Array<{ lo: string; hi: string }>,
    clipPoly: LonLatPolygon | null,
    severities?: Set<"f" | "i" | "p">,
    labels: "full" | "nums" = "full",
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
    const cols = ["cellid", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "fatal_years"]
    if (labels === "full") cols.push(...LABEL_KEYS)
    const sql = `SELECT ${cols.join(", ")} FROM cells_s2_l${level} WHERE ${where}`
    const { results } = await db.prepare(sql).all<{
        cellid: string
        n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs: number
        fatal_years: string | null
        sld_name?: string | null; cross_sld_name?: string | null; mun?: string | null; county?: string | null
    }>()
    const cells: CellOut[] = []
    for (const row of results) {
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
        }
        if (wantF && row.fatal_years) {
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

    return { cells, res, yearRange, severities, clipPolygon, maxCells, shardRes, labels, labelMaxCells }
}
