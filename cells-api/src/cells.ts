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
import { cellToLatLng, cellToParent } from "h3-js"
import { loadManifest } from "./manifest"
import { readParquetFromR2 } from "./parquet"

/** GeoJSON-like polygon: outer ring as `[lon, lat][]`. We keep just one
 *  ring; multi-ring (holes) doesn't show up for our use cases. */
type LonLatPolygon = [number, number][]

type RawRow = {
    year: number
    h3_r14: bigint | number
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
}

export type CellOut = {
    h3: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
}

export type CellsResponse = {
    res: number
    year_range: [number, number]
    data_version: string
    source: "pyramid" | "raw"
    cells: CellOut[]
}

export type CellsRequest = {
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
}

function bigintToHex(b: bigint | number): string {
    return (typeof b === "bigint" ? b : BigInt(b)).toString(16).padStart(15, "0")
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
): Promise<CellsResponse> {
    const manifest = await loadManifest(bucket, prefix)
    const { cells: requestedShards, res: requestedRes, maxCells, shardRes } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities  // undefined ⇒ all

    if (requestedRes < 0 || requestedRes > manifest.base_res) {
        throw new HttpError(400, `res ${requestedRes} out of range [0, ${manifest.base_res}]`)
    }
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }

    // Multi-resolution combo path: client specifies `(shard_res, data_res)`.
    // Worker reads `pyramid/s{shard_res}_r{data_res}/{shard}.parquet`
    // directly, no coarsening (the client picks a combo whose cell count
    // is already in budget). `maxCells` is ignored on the combo path.
    if (shardRes != null) {
        const combos = manifest.pyramid_combos ?? []
        const combo = combos.find(c => c.shard_res === shardRes && c.data_res === requestedRes)
        if (!combo) {
            const avail = combos.map(c => `s${c.shard_res}/r${c.data_res}`).join(", ")
            throw new HttpError(404, `no combo (shard_res=${shardRes}, data_res=${requestedRes}); have: [${avail}]`)
        }
        const known = new Set(combo.shard_cells)
        const shards = requestedShards.filter(s => known.has(s))
        const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null
        const cells = await queryPyramid(bucket, prefix, requestedRes, shards, yearRange, sevSet, clipPoly, shardRes)
        return {
            res: requestedRes,
            year_range: yearRange,
            data_version: manifest.data_version,
            source: "pyramid",
            cells,
        }
    }

    // Legacy path: shards keyed at `manifest.shard_res`, pyramid levels are
    // single-shard-res. Adaptive coarsening when `maxCells` exceeded.
    // Intersect with the manifest's known shard set so an unknown cell
    // (typo, stale client, off-NJ shard) becomes a silent skip rather
    // than a 404 on the parquet read.
    const known = new Set(manifest.shard_cells)
    const shards = requestedShards.filter(s => known.has(s))

    // Adaptive res: start at requested, walk coarser if cells.length
    // exceeds `maxCells`. Each step is a fresh parquet read (lossless,
    // since each pyramid level is independently aggregated). When
    // `maxCells` is omitted, we always return at the requested res.
    const MIN_RES = 5
    const clipPoly = req.clipPolygon && req.clipPolygon.length >= 3 ? req.clipPolygon : null
    let res = requestedRes
    while (res >= MIN_RES) {
        const usePyramid = res < manifest.base_res && manifest.pyramid_levels.includes(res)
        const cells = usePyramid
            ? await queryPyramid(bucket, prefix, res, shards, yearRange, sevSet, clipPoly)
            : await queryRaw(bucket, prefix, manifest, res, shards, yearRange, sevSet, clipPoly)
        if (maxCells == null || cells.length <= maxCells || res === MIN_RES) {
            return {
                res,
                year_range: yearRange,
                data_version: manifest.data_version,
                source: usePyramid ? "pyramid" : "raw",
                cells,
            }
        }
        res--
    }
    // Unreachable — loop returns at res === MIN_RES.
    throw new Error("unreachable")
}

async function queryPyramid(
    bucket: R2Bucket,
    prefix: string,
    res: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clipPoly: LonLatPolygon | null,
    shardRes?: number,
): Promise<CellOut[]> {
    const h3Col = `h3_r${res}`
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()
    // Multi-res combos live under `pyramid/s{shard_res}_r{data_res}/...`;
    // legacy single-shard-res pyramid lives under `pyramid/r{res}/...`.
    const subdir = shardRes != null ? `s${shardRes}_r${res}` : `r${res}`

    for (const s of shards) {
        let rows: PyramidRow[]
        try {
            rows = await readParquetFromR2<PyramidRow>(
                bucket, `${prefix}/pyramid/${subdir}/${s}.parquet`,
                {
                    columns: [h3Col, "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
                    filter: { year: { $gte: yearRange[0], $lte: yearRange[1] } },
                },
            )
        } catch (e) {
            console.error(`pyramid ${subdir}/${s} read failed:`, e)
            continue
        }
        for (const row of rows) {
            const cellId = (row as any)[h3Col] ?? row.h3
            const hex = bigintToHex(cellId)
            if (!cellInPolygon(hex, clipPoly)) continue
            let c = out.get(hex)
            if (!c) {
                c = { h3: hex, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
                out.set(hex, c)
            }
            if (wantF) c.n_fatal += row.n_fatal
            if (wantI) { c.n_inj_ped += row.n_inj_ped; c.n_inj_other += row.n_inj_other }
            if (wantP) c.n_pdo += row.n_pdo
            c.n_vehs += row.n_vehs ?? 0
        }
    }
    return [...out.values()]
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

    for (const s of shards) {
        let rows: RawRow[]
        try {
            rows = await readParquetFromR2<RawRow>(
                bucket, `${prefix}/raw/h3_r${baseRes}/${s}.parquet`,
                {
                    columns: [h3Col, "year", "severity", "tk", "ti", "pk", "pi", "tv"],
                    filter,
                },
            )
        } catch (e) {
            console.error(`raw r${baseRes}/${s} read failed:`, e)
            continue
        }
        for (const row of rows) {
            const cellId = (row as any)[h3Col] ?? row.h3_r14
            const baseHex = bigintToHex(cellId)
            const ancHex = fastPath ? baseHex : cellToParent(baseHex, res)
            if (!cellInPolygon(ancHex, clipPoly)) continue
            const sev = row.severity
            let c = out.get(ancHex)
            if (!c) {
                c = { h3: ancHex, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
                out.set(ancHex, c)
            }
            if (wantF && sev === "f") c.n_fatal += 1
            if (wantI && sev === "i") { c.n_inj_ped += row.pi; c.n_inj_other += row.ti - row.pi }
            if (wantP && sev === "p") c.n_pdo += 1
            c.n_vehs += row.tv ?? 0
        }
    }
    return [...out.values()]
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
    const cellsStr = url.searchParams.get("cells")
    if (!cellsStr) throw new HttpError(400, "cells is required (comma-separated h3 hex strings)")
    const cells = cellsStr.split(",").map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length === 0) throw new HttpError(400, "cells must list ≥1 shard")
    // Validate hex string shape (h3 cells are 15-char lowercase hex, but
    // shard parents at coarser res may have trailing "fffffff" padding —
    // accept anything that looks like a 15-char [0-9a-f] string.
    if (cells.some(c => !/^[0-9a-f]{15}$/.test(c))) {
        throw new HttpError(400, "cells must be 15-char lowercase hex h3 IDs")
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
    const ss = url.searchParams.get("severities")
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

    return { cells, res, yearRange, severities, clipPolygon, maxCells, shardRes }
}
