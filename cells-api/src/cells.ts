/** `/v1/cells` request handler.
 *
 *  **Shard-keyed.** The client computes which `shard_res` parent cells
 *  intersect its viewport (via `polygonToCellsExperimental` against the
 *  manifest's `shard_cells`) and fires one request per shard. The
 *  worker just dumps that shard's pyramid (or aggregates raw → res).
 *  Each (shard, res, years, sevs, polygon_hash) is independently
 *  cacheable on the client; panning over already-fetched shards = zero
 *  worker invocations.
 *
 *  Two query paths (per shard):
 *  - **Pyramid**: `res < base_res` and a pyramid for `res` exists.
 *    Read the shard's per-resolution rollup, filter to year + severity,
 *    group by cell, optionally clip to polygon. Returns one row per
 *    non-empty cell.
 *  - **Raw fallback**: requested resolution >= base_res, or pyramid
 *    missing for `res`. Read the raw r{base} shard (with year
 *    pushdown), aggregate up to `res` via `cellToParent`, optionally
 *    clip.
 *
 *  Memory shape: shards are processed **sequentially**. Per shard we
 *  filter + fold rows into the running cell-map then drop the parsed
 *  batch. Peak memory ≈ one shard's parsed batch + the output Map.
 *
 *  Response shape:
 *
 *      {
 *        res: number,
 *        year_range: [number, number],
 *        data_version: string,
 *        source: "pyramid" | "raw",
 *        cells: [{ h3, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs }]
 *      }
 */
import { cellToLatLng, cellToParent, getResolution } from "h3-js"
import { descendantRange, mergeRanges, type CellRange } from "./h3-range"
import { loadManifest } from "./manifest"
import { readParquetFromR2 } from "./parquet"
import {
    s2IdToToken,
    s2LevelOf,
    s2Parent,
    s2RangeForCell,
    s2TokenToId,
} from "./s2-range"

/** GeoJSON-like polygon: outer ring as `[lon, lat][]`. We keep just one
 *  ring; multi-ring (holes) doesn't show up for our use cases. */
type LonLatPolygon = [number, number][]

type RawRow = {
    year: number
    h3_r15: bigint | number
    severity: "f" | "i" | "p"
    cc: number
    mc: number
    tk: number
    ti: number
    pk: number
    pi: number
    tv: number
}

type PyramidRow = {
    h3: bigint | number
    year: number
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs?: number
    // Baked into every pyramid row by `njdot compute cells pyramid-combos`
    // (see `_build_pyramid_level`). Constant across a cell's year-rows.
    sld_name?: string | null
    cross_sld_name?: string | null
    mun?: string | null
    county?: string | null
}

export type CellOut = {
    h3: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
    /** Years (ascending) in which this cell had ≥1 fatal crash. Omitted
     *  when n_fatal === 0. Used by the hex tooltip to show "Fatal: 2018,
     *  2020, 2022" instead of just a bare count. */
    fatal_years?: number[]
    /** Primary road at this cell's centroid, baked into the pyramid row
     *  at build time (`njdot compute cells pyramid-combos`, joined from
     *  `hex-sld.parquet` with an r11-ancestor fallback for data_res > 11).
     *  Omitted for ocean/off-road cells. Used by the hex tooltip; replaced
     *  the 15 MB client-side `hex-sld.parquet` fetch and the former
     *  per-request `joinSld` sidecar read. */
    sld_name?: string
    /** Cross-street from the same baked source. Populated for cells within
     *  ~80m of a different SRI; ~25-75% of cells depending on res. */
    cross_sld_name?: string
    mun?: string
    county?: string
}

/** In-worker parent-aggregate — used to drop one H3 res in the combo
 *  path when a shard came back with more cells than `maxCells`. Cheaper
 *  than re-reading a coarser parquet (no extra R2 hit), and the sum-
 *  of-tiers semantics match how the offline pyramid rollup was built. */
export function coarsenCells(cells: CellOut[], toRes: number): CellOut[] {
    if (cells.length === 0) return cells
    const parents = new Map<string, CellOut>()
    for (const c of cells) {
        const ph = cellToParent(c.h3, toRes)
        let p = parents.get(ph)
        if (!p) {
            p = {
                h3: ph,
                n_fatal: 0,
                n_inj_ped: 0,
                n_inj_other: 0,
                n_pdo: 0,
                n_vehs: 0,
            }
            parents.set(ph, p)
        }
        p.n_fatal += c.n_fatal
        p.n_inj_ped += c.n_inj_ped
        p.n_inj_other += c.n_inj_other
        p.n_pdo += c.n_pdo
        p.n_vehs += c.n_vehs
        if (c.fatal_years && c.fatal_years.length > 0) {
            (p.fatal_years ??= []).push(...c.fatal_years)
        }
        // Inherit the tooltip labels from the first child that carries a
        // road name — a representative proxy for the coarsened cell (the
        // baked pyramid can't pre-label these dynamically-merged parents).
        if (p.sld_name == null && c.sld_name != null) {
            p.sld_name = c.sld_name
            p.cross_sld_name = c.cross_sld_name
            p.mun = c.mun
            p.county = c.county
        }
    }
    for (const p of parents.values()) {
        if (p.fatal_years) p.fatal_years = [...new Set(p.fatal_years)].sort((a, b) => a - b)
    }
    return [...parents.values()]
}

export type CellsResponse = {
    res: number
    year_range: [number, number]
    data_version: string
    source: "pyramid" | "raw" | "d1"
    cells: CellOut[]
}

export type CellsRequest = {
    /** Which grid the request operates on. Defaults to `h3` (existing
     *  shipping stack). `s2` routes to the S2 pyramid/D1 rollup e built
     *  in `specs/s2-pyramid.md` phase 3. Client sends `grid=s2` when
     *  the URL param `?grid=s2` is set; picker computes an S2 level
     *  instead of an H3 res. Cell tokens in `cells` are grid-specific
     *  (H3 15-char hex vs. S2 up-to-16-char hex). */
    grid?: "h3" | "s2"
    /** `shard_res` parent cells (h3 hex strings) the client wants data
     *  for. Client computes these from its viewport bbox via
     *  `polygonToCellsExperimental` against the manifest's
     *  `shard_cells`; worker iterates them in order. Unknown shards
     *  (no parquet at that key) are silently skipped. */
    cells: string[]
    res: number
    yearRange?: [number, number]
    severities?: Set<"f" | "i" | "p">
    /** Optional polygon to clip the response to. Cells whose center is
     *  not in the polygon are dropped. Used for county/muni scopes so
     *  the embed for `/c/hudson` doesn't show neighboring hexes that
     *  happen to fall in a requested r4 shard. */
    clipPolygon?: LonLatPolygon
    /** Optional max cell count. If the response at the requested `res`
     *  would exceed this, the worker walks coarser (drops the fetched
     *  pyramid, reads the next-coarser one) until it fits or hits MIN.
     *  Result includes `res: actualRes` so the client knows what
     *  resolution was actually returned. */
    maxCells?: number
    /** Optional shard resolution for the multi-res pyramid combos. When
     *  set, the worker reads `pyramid/s{shardRes}_r{res}/{shard}.parquet`
     *  instead of the legacy `pyramid/r{res}/{shard}.parquet` (which is
     *  implicitly sharded at `manifest.shard_res`). The manifest enumerates
     *  available `(shard_res, data_res)` combos in `pyramid_combos`; the
     *  client picks one whose viewport-shard-count is in a target range. */
    shardRes?: number
    /** Which columns to materialize, splitting the expensive string-label
     *  decode off the paint critical path (labels are ~37% of decode but
     *  tooltip-only). Default `full` = counts + labels (back-compat).
     *  - `nums`: counts only (drops sld_name/cross_sld_name/mun/county).
     *    Paints the map + bars; ~37% faster decode.
     *  - `only`: labels only, keyed by h3 — the backfill/hover request the
     *    client merges into already-painted cells. Year-invariant, so no
     *    year filter; deduped by h3; count fields are 0. */
    labels?: "full" | "nums" | "only"
}

function bigintToHex(b: bigint | number): string {
    return (typeof b === "bigint" ? b : BigInt(b)).toString(16).padStart(15, "0")
}

function hexToBigint(hex: string): bigint {
    return BigInt(`0x${hex}`)
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

/** Test whether a cell's centroid lies inside the clip polygon. Cheap
 *  per-row (5–500 polygon verts × O(1) per row), avoids the
 *  `polygonToCellsExperimental` blowup on large statewide polygons at
 *  fine res (NJ envelope at r11 ≈ 500k cells → OOM). */
function cellInPolygon(hex: string, poly: LonLatPolygon | null): boolean {
    if (!poly) return true
    const [lat, lng] = cellToLatLng(hex)
    return pointInPolygon([lng, lat], poly)
}

export async function handleCellsRequest(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
    db?: D1Database,
): Promise<CellsResponse> {
    if (req.grid === "s2") {
        // S2 grid — parallel dispatch to the S2 pyramid path. D1 fast
        // path lands in phase 4b3 once `CELLS_S2_DB` is bound. Parquet
        // path (below) already handles all filter shapes we support.
        return await handleCellsRequestS2(bucket, prefix, req)
    }
    const manifest = await loadManifest(bucket, prefix)
    const { cells: requestedShards, res: requestedRes, maxCells } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities  // undefined ⇒ all

    if (requestedRes < 0 || requestedRes > manifest.base_res) {
        throw new HttpError(400, `res ${requestedRes} out of range [0, ${manifest.base_res}]`)
    }
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }

    // Consolidated read: every data_res is one r4-sharded level
    // (`pyramid/r{res}/{r4}.parquet`, h3-sorted + row-grouped). The client's
    // cover cells (`requestedShards`, at any resolution — a legacy `shard_res`
    // param is ignored) become the prune ancestors: their base-res descendant
    // ranges (`rangesForCovering`) drive hyparquet row-group pruning so each
    // r4 shard yields only the ~viewport row-groups. `maxCells` still triggers
    // in-worker coarsening; `res` in the response is ground truth.
    const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null
    const fileRes = manifest.shard_res  // r4: the physical file-sharding resolution
    const MIN_RES = 5

    // r4 shard files to read: each cover cell's r4 ancestor (a cover cell at
    // exactly r4 maps to itself). Only a cover cell strictly coarser than r4
    // spans multiple r4 shards → fall back to all known r4 shards (cheap —
    // coarse levels are small, and `missingOk` skips empties). `cellToParent`
    // to a *finer* res throws, so the guard must be strict.
    const anyCoarse = requestedShards.some(s => getResolution(s) < fileRes)
    const shards = anyCoarse
        ? manifest.shard_cells
        : [...new Set(requestedShards.map(s => cellToParent(s, fileRes)))]

    const labels = req.labels ?? "full"

    // Viewport-cover h3 ranges — shared by the D1 fast path and the parquet
    // row-group pruning below.
    const ranges = mergeRanges(
        requestedShards.map(s => descendantRange(hexToBigint(s), getResolution(s), requestedRes)),
    )

    // D1 fast path: the default (all-years, all-severity, full-labels) query
    // at a res the rollup covers (r6-r15). One indexed `h3 BETWEEN` range scan
    // returns counts + labels together — no year-row expansion, no string
    // re-decode. Any failure (binding absent, table missing, result too large)
    // falls through to the parquet path below.
    // "All severities" = absent or all three present (the client always sends
    // `severities=fip` for the default view, never omits it). "All years" =
    // the requested range *covers* the data range — the client's default
    // upper year is the calendar year (e.g. 2026), which overshoots the data
    // (2025), so an exact match would never fire. A covering range is a no-op
    // filter, so the all-years D1 rollup is exact.
    const allSev = !sevSet || (sevSet.has("f") && sevSet.has("i") && sevSet.has("p"))
    const coversAllYears = req.yearRange == null
        || (req.yearRange[0] <= manifest.year_range[0] && req.yearRange[1] >= manifest.year_range[1])
    const isDefault = allSev && coversAllYears
    if (db && isDefault && labels === "full" && requestedRes >= 6 && requestedRes <= manifest.base_res) {
        try {
            const t0 = Date.now()
            let cells = await queryCellsD1(db, requestedRes, ranges, clipPoly)
            const t1 = Date.now()
            let res = requestedRes
            while (maxCells != null && cells.length > maxCells && res > MIN_RES) {
                res--
                cells = coarsenCells(cells, res)
            }
            const t2 = Date.now()
            console.log(`[timing] r${requestedRes} D1 ranges=${ranges.length} cells=${cells.length}: d1=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
            return { res, year_range: yearRange, data_version: manifest.data_version, source: "d1", cells }
        } catch (e) {
            console.error(`D1 path failed (res ${requestedRes}), falling back to parquet:`, e)
        }
    }

    const usePyramid = manifest.pyramid_levels.includes(requestedRes)
    if (usePyramid) {
        const t0 = Date.now()
        let cells = await queryPyramid(bucket, prefix, requestedRes, shards, yearRange, sevSet, clipPoly, ranges, labels)
        const t1 = Date.now()
        let res = requestedRes
        // Label-only requests are keyed lookups the client merges into
        // already-painted cells at the paint's actual res — never coarsened
        // (counts are 0 here, so `maxCells` wouldn't apply meaningfully).
        while (labels !== "only" && maxCells != null && cells.length > maxCells && res > MIN_RES) {
            res--
            cells = coarsenCells(cells, res)
        }
        const t2 = Date.now()
        console.log(`[timing] r${requestedRes} labels=${labels} shards=${shards.length} ranges=${ranges.length} cells=${cells.length}: pyramid=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
        return {
            res,
            year_range: yearRange,
            data_version: manifest.data_version,
            source: "pyramid",
            cells,
        }
    }

    // Raw fallback for a res below the finest pyramid level (rare — very wide
    // zoom). Aggregates raw crashes up to `res` via `cellToParent`.
    const cells = await queryRaw(bucket, prefix, manifest, requestedRes, shards, yearRange, sevSet, clipPoly)
    return {
        res: requestedRes,
        year_range: yearRange,
        data_version: manifest.data_version,
        source: "raw",
        cells,
    }
}

/** D1 fast path for the default (all-years, all-severity) query. Reads the
 *  per-cell rollup `cells_r{res}` (one row/cell — counts + labels) with a
 *  single indexed range scan over the viewport cover's merged h3 ranges.
 *
 *  h3 comes back as TEXT: D1 hands INTEGER columns to JS as `number`, which
 *  loses precision above 2^53 (h3 ids are ~6e17). Range bounds are inlined as
 *  decimal literals — they're server-computed int64s (not user input), which
 *  also sidesteps D1's lack of an int64 bind type. */
async function queryCellsD1(
    db: D1Database,
    res: number,
    ranges: CellRange[],
    clipPoly: LonLatPolygon | null,
): Promise<CellOut[]> {
    const where = ranges.length
        ? ranges.map(r => `(h3 BETWEEN ${r.lo.toString()} AND ${r.hi.toString()})`).join(" OR ")
        : "1=1"
    const sql = `SELECT CAST(h3 AS TEXT) AS h3, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, `
        + `fatal_years, sld_name, cross_sld_name, mun, county FROM cells_r${res} WHERE ${where}`
    const { results } = await db.prepare(sql).all<{
        h3: string
        n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs: number
        fatal_years: string | null
        sld_name: string | null; cross_sld_name: string | null; mun: string | null; county: string | null
    }>()
    const cells: CellOut[] = []
    for (const row of results) {
        // Match the parquet path: drop cells with no severity-count hit.
        if (!(row.n_fatal > 0 || row.n_inj_ped > 0 || row.n_inj_other > 0 || row.n_pdo > 0)) continue
        const hex = bigintToHex(BigInt(row.h3))
        if (!cellInPolygon(hex, clipPoly)) continue
        const c: CellOut = {
            h3: hex,
            n_fatal: row.n_fatal, n_inj_ped: row.n_inj_ped, n_inj_other: row.n_inj_other,
            n_pdo: row.n_pdo, n_vehs: row.n_vehs,
        }
        // `fatal_years` is pre-sorted ascending by the builder (string_agg
        // ORDER BY year), matching the parquet path's output.
        if (row.fatal_years) c.fatal_years = row.fatal_years.split(",").map(Number)
        if (row.sld_name) c.sld_name = row.sld_name
        if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
        if (row.mun) c.mun = row.mun
        if (row.county) c.county = row.county
        cells.push(c)
    }
    return cells
}

async function queryPyramid(
    bucket: R2Bucket,
    prefix: string,
    res: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
    h3Ranges?: CellRange[],
    labels: "full" | "nums" | "only" = "full",
): Promise<CellOut[]> {
    const h3Col = `h3_r${res}`
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()
    // Consolidated layout: every data_res lives under `pyramid/r{res}/`,
    // sharded at r4 (h3-sorted, row-grouped) with sld baked into every row.
    const subdir = `r${res}`
    // Row-group pruning: `h3Ranges` are the base-res descendant ranges of the
    // viewport cover (`rangesForCovering`). Passed as an `$or` of `h3_r{res}`
    // ranges so hyparquet skips row-groups whose min/max stats fall outside
    // every range — fetching only the ~viewport row-groups from each r4 shard
    // (measured ~3-4% of a shard's bytes).
    const h3RangeOr = h3Ranges && h3Ranges.length
        ? { $or: h3Ranges.map(r => ({ [h3Col]: { $gte: r.lo, $lte: r.hi } })) }
        : null

    // Label-only path: the string labels (~37% of decode) are tooltip-only
    // and constant across a cell's year-rows, so skip the year filter and
    // decode just h3 + the 4 string cols, deduping by h3. Returns one record
    // per labeled cell (counts 0); the client merges these into the cells it
    // already painted from a `labels=nums` request.
    if (labels === "only") {
        const cols = [h3Col, "sld_name", "cross_sld_name", "mun", "county"]
        const results = await Promise.all(shards.map(async s => {
            try {
                return await readParquetFromR2<PyramidRow>(
                    bucket, `${prefix}/pyramid/${subdir}/${s}.parquet`,
                    { columns: cols, filter: h3RangeOr ?? undefined, missingOk: true },
                )
            } catch (e) {
                console.error(`pyramid ${subdir}/${s} labels read failed:`, e)
                return null
            }
        }))
        for (const rows of results) {
            if (!rows) continue
            for (const row of rows) {
                const hex = bigintToHex((row as any)[h3Col] ?? row.h3)
                if (out.has(hex)) continue
                if (!row.sld_name && !row.cross_sld_name && !row.mun && !row.county) continue
                if (!cellInPolygon(hex, clipPoly)) continue
                const c: CellOut = { h3: hex, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
                if (row.sld_name) c.sld_name = row.sld_name
                if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
                if (row.mun) c.mun = row.mun
                if (row.county) c.county = row.county
                out.set(hex, c)
            }
        }
        return [...out.values()]
    }

    // `nums` drops the 4 string cols; `full` keeps them (back-compat default).
    const cols = labels === "nums"
        ? [h3Col, "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"]
        : [h3Col, "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs", "sld_name", "cross_sld_name", "mun", "county"]

    // ANDed with the year pushdown for the count path.
    const yearFilter = { year: { $gte: yearRange[0], $lte: yearRange[1] } }
    const filter = h3RangeOr ? { $and: [yearFilter, h3RangeOr] } : yearFilter

    // Parallel R2 reads — each r4 shard's parquet reads concurrently via
    // `Promise.all`; total latency ≈ the slowest single shard plus overhead.
    const results = await Promise.all(shards.map(async s => {
        try {
            return await readParquetFromR2<PyramidRow>(
                bucket, `${prefix}/pyramid/${subdir}/${s}.parquet`,
                {
                    columns: cols,
                    filter,
                    missingOk: true,
                },
            )
        } catch (e) {
            console.error(`pyramid ${subdir}/${s} read failed:`, e)
            return null
        }
    }))
    for (const rows of results) {
        if (!rows) continue
        for (const row of rows) {
            const cellId = (row as any)[h3Col] ?? row.h3
            const hex = bigintToHex(cellId)
            if (!cellInPolygon(hex, clipPoly)) continue
            let c = out.get(hex)
            if (!c) {
                c = { h3: hex, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
                // sld labels are baked per-row and constant across a cell's
                // year-rows — set once on first sight (truthy skips nulls).
                if (row.sld_name) c.sld_name = row.sld_name
                if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
                if (row.mun) c.mun = row.mun
                if (row.county) c.county = row.county
                out.set(hex, c)
            }
            if (wantF) {
                c.n_fatal += row.n_fatal
                if (row.n_fatal > 0) {
                    // Pyramid rows are unique per (h3, year), so we never push
                    // a duplicate year for the same cell. Sorted at the end
                    // before returning so the tooltip renders ascending.
                    ;(c.fatal_years ??= []).push(row.year)
                }
            }
            if (wantI) { c.n_inj_ped += row.n_inj_ped; c.n_inj_other += row.n_inj_other }
            if (wantP) c.n_pdo += row.n_pdo
            c.n_vehs += row.n_vehs ?? 0
        }
    }
    // Drop cells where none of the requested severities had a hit. The
    // pyramid row-loop pre-allocates a cell entry on the *first* row
    // visit and then only accumulates `n_vehs` (which is severity-blind),
    // so urban shards end up shipping ~70% all-zero-count cells. The
    // client already filters `total === 0` client-side; shipping them
    // is pure waste.
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

/** Point-in-polygon variant for S2 cells. Reuses `pointInPolygon`
 *  after resolving the cell's centroid via S2 bit math (`nodes2ts` is
 *  used in tests but not the shipping bundle — we can compute the
 *  centroid from an id without the lib once the S2 cell arithmetic
 *  lands in phase 4b2b). For now, this is a no-op: the pyramid path
 *  passes null for `clipPoly` from the initial S2 wiring since the
 *  client hasn't yet learned to send S2-specific polygon clips.
 *  Real per-cell centroid resolution comes in phase 4e (client render). */
function cellInPolygonS2(_token: string, poly: LonLatPolygon | null): boolean {
    return !poly
}

/** S2 handler mirroring `handleCellsRequest`'s H3 body. Reads the
 *  manifest for `data_version` + `year_range` (both grid-agnostic
 *  — the pipeline stamps the same values on both grids), computes
 *  S2 token ranges from the request shards, and delegates to
 *  `queryPyramidS2` for the R2 parquet fetch. D1 fast path is
 *  phase 4b3 (needs `CELLS_S2_DB` binding). */
async function handleCellsRequestS2(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
): Promise<CellsResponse> {
    const manifest = await loadManifest(bucket, prefix)
    const { cells: requestedShards, res: requestedLevel, maxCells } = req
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }
    // S2 level range mirrors the pyramid build (`e` phase 3): data
    // levels 4-16, base 16. Reject outside this envelope up front so
    // the R2 fetch doesn't 404 on us.
    const S2_MIN_LEVEL = 4
    const S2_MAX_LEVEL = 16
    if (requestedLevel < S2_MIN_LEVEL || requestedLevel > S2_MAX_LEVEL) {
        throw new HttpError(400, `s2 level ${requestedLevel} out of range [${S2_MIN_LEVEL}, ${S2_MAX_LEVEL}]`)
    }
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities
    // Clip polygon plumbing — currently disabled for S2 (see
    // `cellInPolygonS2`); passes through so phase 4e can turn it on.
    const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null
    const labels = req.labels ?? "full"

    // Build cellid ranges at the target level from the shard tokens.
    // Each shard's `[lo, hi]` is a bigint pair; we serialize to
    // 16-char zero-padded hex for parquet TEXT-column comparison
    // (matches how `njdot/s2.py` stores tokens on disk).
    const ranges: Array<{ lo: string; hi: string }> = []
    for (const shard of requestedShards) {
        const parentId = s2TokenToId(shard)
        const parentLevel = s2LevelOf(parentId)
        if (parentLevel > requestedLevel) {
            throw new HttpError(400,
                `s2 shard level ${parentLevel} finer than requested level ${requestedLevel}`)
        }
        // At parentLevel == requestedLevel, `s2RangeForCell` collapses
        // to a single cell — still a valid (degenerate) range.
        const { lo, hi } = s2RangeForCell(parentId, requestedLevel)
        // Zero-pad to 16 chars — that's the canonical sort order for
        // the D1 TEXT column and the parquet stats min/max. The token
        // format on wire strips trailing zeros; padding restores the
        // full lex order.
        ranges.push({
            lo: lo === 0n ? "".padStart(16, "0") : lo.toString(16).padStart(16, "0"),
            hi: hi === 0n ? "".padStart(16, "0") : hi.toString(16).padStart(16, "0"),
        })
    }

    const t0 = Date.now()
    let cells = await queryPyramidS2(
        bucket, prefix, requestedLevel, requestedShards, yearRange, sevSet,
        clipPoly, ranges, labels,
    )
    const t1 = Date.now()
    let level = requestedLevel
    // In-worker coarsening (mirrors the H3 path). Uses S2 parent walk
    // instead of `cellToParent`; s2's exact-tiling property means
    // sums roll up losslessly (the whole point of migrating off H3).
    while (labels !== "only" && maxCells != null && cells.length > maxCells && level > S2_MIN_LEVEL) {
        level--
        cells = coarsenCellsS2(cells, level)
    }
    const t2 = Date.now()
    console.log(`[timing] s2 l${requestedLevel} labels=${labels} shards=${requestedShards.length} ranges=${ranges.length} cells=${cells.length}: pyramid=${t1 - t0}ms, coarsen=${t2 - t1}ms, total=${t2 - t0}ms`)
    return {
        res: level,
        year_range: yearRange,
        data_version: manifest.data_version,
        source: "pyramid",
        cells,
    }
}

/** S2 analog of `queryPyramid`. Reads `s2_pyramid/s2_l{level}/{token}.parquet`
 *  for each requested shard, applies row-group pruning via the
 *  `cellid BETWEEN` ranges the caller computed, aggregates rows across
 *  year (drops the year filter's row multiplication), and returns
 *  one `CellOut` per unique cell.
 *
 *  Cell keys in the output reuse the `h3` field name for wire-format
 *  parity with the H3 path — the client interprets it as an S2 token
 *  when `grid=s2` is active. Renaming that field to a grid-agnostic
 *  `cell_id` is a follow-up (touches every downstream client op). */
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
    // Row-group pruning uses `$or` of `cellid` bounds, same shape as H3.
    const cellidRangeOr = tokenRanges.length
        ? { $or: tokenRanges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) }
        : null
    const subdir = `s2_pyramid/s2_l${level}`

    if (labels === "only") {
        const cols = ["cellid", "sld_name", "cross_sld_name", "mun", "county"]
        const results = await Promise.all(shards.map(async s => {
            try {
                return await readParquetFromR2<any>(
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
                const c: CellOut = { h3: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
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
            return await readParquetFromR2<any>(
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
                c = { h3: token, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
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

/** S2 analog of `coarsenCells` — rolls fine-level cells up to a coarser
 *  target level via the S2 parent walk. Lossless because S2 children
 *  exactly tile their parents (unlike H3's boundary-triangle drift). */
function coarsenCellsS2(cells: CellOut[], toLevel: number): CellOut[] {
    if (cells.length === 0) return cells
    const parents = new Map<string, CellOut>()
    for (const c of cells) {
        const childId = s2TokenToId(c.h3)
        const parentId = s2Parent(childId, toLevel)
        const parentToken = s2IdToToken(parentId)
        let p = parents.get(parentToken)
        if (!p) {
            p = {
                h3: parentToken,
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

async function queryRaw(
    bucket: R2Bucket,
    prefix: string,
    manifest: { base_res: number },
    res: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
): Promise<CellOut[]> {
    const baseRes = manifest.base_res
    const h3Col = `h3_r${baseRes}`
    // Without a bbox, the spatial filter degenerates: read the whole
    // shard's r{base} rows (year + clip do the work). Each shard is one
    // r4 cell ≈ 5000 km² which keeps the read bounded — the pyramid
    // path is preferred for typical queries.
    // Without a bbox-derived covering, year is the only parquet
    // pushdown filter. Each shard's raw r{base} file holds ≈250k–1M
    // rows over 5y; reading the year-filtered slice is the slow path,
    // but the only one available without a bounding region.
    const filter = { year: { $gte: yearRange[0], $lte: yearRange[1] } }

    // r14 fast path: rows are already at the target res, so each row's
    // h3_r{base} IS the output cell — no `cellToParent` per row.
    const fastPath = res === baseRes
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()

    // Parallel R2 reads (same rationale as queryPyramid).
    const results = await Promise.all(shards.map(async s => {
        try {
            return await readParquetFromR2<RawRow>(
                bucket, `${prefix}/raw/h3_r${baseRes}/${s}.parquet`,
                {
                    columns: [h3Col, "year", "severity", "tk", "ti", "pk", "pi", "tv"],
                    filter,
                },
            )
        } catch (e) {
            console.error(`raw r${baseRes}/${s} read failed:`, e)
            return null
        }
    }))
    for (const rows of results) {
        if (!rows) continue
        for (const row of rows) {
            const cellId = (row as any)[h3Col] ?? row.h3_r15
            const baseHex = bigintToHex(cellId)
            const ancHex = fastPath ? baseHex : cellToParent(baseHex, res)
            if (!cellInPolygon(ancHex, clipPoly)) continue
            const sev = row.severity
            let c = out.get(ancHex)
            if (!c) {
                c = { h3: ancHex, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
                out.set(ancHex, c)
            }
            if (wantF && sev === "f") {
                c.n_fatal += 1
                // Raw rows are per-crash; dedupe-sort happens after the loop.
                ;(c.fatal_years ??= []).push(row.year)
            }
            if (wantI && sev === "i") { c.n_inj_ped += row.pi; c.n_inj_other += row.ti - row.pi }
            if (wantP && sev === "p") c.n_pdo += 1
            c.n_vehs += row.tv ?? 0
        }
    }
    // Drop cells with no requested-severity hits (see queryPyramid for
    // rationale). Plus dedupe + sort fatal_years on the keepers (raw
    // rows are per-crash; same year may appear N≥1 times in a cell).
    const cells: CellOut[] = []
    for (const c of out.values()) {
        const keep =
            (wantF && c.n_fatal > 0) ||
            (wantI && (c.n_inj_ped > 0 || c.n_inj_other > 0)) ||
            (wantP && c.n_pdo > 0)
        if (!keep) continue
        if (c.fatal_years) c.fatal_years = [...new Set(c.fatal_years)].sort((a, b) => a - b)
        cells.push(c)
    }
    return cells
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
    let grid: "h3" | "s2" | undefined
    const g = url.searchParams.get("grid")
    if (g != null) {
        if (g !== "h3" && g !== "s2") throw new HttpError(400, "grid must be one of h3|s2")
        grid = g
    }

    const cellsStr = url.searchParams.get("cells")
    if (!cellsStr) throw new HttpError(400, "cells is required (comma-separated cell tokens)")
    const cells = cellsStr.split(",").map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length === 0) throw new HttpError(400, "cells must list ≥1 shard")
    // H3 cells are always 15-char lowercase hex (including trailing
    // "fffffff" padding for shard parents at coarser res). S2 tokens
    // are lowercase hex with trailing zeros stripped (so length 1-16),
    // or the literal `"X"` for cell id 0.
    if (grid === "s2") {
        if (cells.some(c => c !== "X" && !/^[0-9a-f]{1,16}$/.test(c))) {
            throw new HttpError(400, "s2 cells must be lowercase hex tokens (or 'X' for id 0)")
        }
    } else if (cells.some(c => !/^[0-9a-f]{15}$/.test(c))) {
        throw new HttpError(400, "h3 cells must be 15-char lowercase hex IDs")
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
        if (!Number.isFinite(n) || n < 0 || n > 15) throw new HttpError(400, "shard_res must be in [0, 15]")
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

    return { grid, cells, res, yearRange, severities, clipPolygon, maxCells, shardRes, labels }
}
