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
import { cellToParent, polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS } from "h3-js"
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
}

function bigintToHex(b: bigint | number): string {
    return (typeof b === "bigint" ? b : BigInt(b)).toString(16).padStart(15, "0")
}

/** Convert a GeoJSON-style `[lon, lat]` ring to h3-js's `[lat, lon]`. */
function lonLatToLatLng(ring: LonLatPolygon): [number, number][] {
    return ring.map(([lon, lat]) => [lat, lon])
}

/** Compute the set of cells at `res` whose CENTER lies inside the polygon,
 *  for use as a final clip pass. Returns null when no clip is requested. */
function clipCovering(
    clipPolygon: LonLatPolygon | undefined,
    res: number,
): Set<string> | null {
    if (!clipPolygon || clipPolygon.length < 3) return null
    const ring = lonLatToLatLng(clipPolygon)
    return new Set(polygonToCellsExperimental(ring, res, POLYGON_TO_CELLS_FLAGS.containmentCenter))
}

export async function handleCellsRequest(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
): Promise<CellsResponse> {
    const manifest = await loadManifest(bucket, prefix)
    const { cells: requestedShards, res } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities  // undefined ⇒ all

    if (res < 0 || res > manifest.base_res) {
        throw new HttpError(400, `res ${res} out of range [0, ${manifest.base_res}]`)
    }
    if (requestedShards.length === 0) {
        throw new HttpError(400, "cells must list ≥1 shard")
    }
    // Intersect with the manifest's known shard set so an unknown cell
    // (typo, stale client, off-NJ shard) becomes a silent skip rather
    // than a 404 on the parquet read.
    const known = new Set(manifest.shard_cells)
    const shards = requestedShards.filter(s => known.has(s))

    const usePyramid = res < manifest.base_res && manifest.pyramid_levels.includes(res)
    const clip = clipCovering(req.clipPolygon, res)

    if (usePyramid) {
        const cells = await queryPyramid(bucket, prefix, res, shards, yearRange, sevSet, clip)
        return {
            res,
            year_range: yearRange,
            data_version: manifest.data_version,
            source: "pyramid",
            cells,
        }
    }
    const cells = await queryRaw(bucket, prefix, manifest, res, shards, yearRange, sevSet, clip)
    return {
        res,
        year_range: yearRange,
        data_version: manifest.data_version,
        source: "raw",
        cells,
    }
}

async function queryPyramid(
    bucket: R2Bucket,
    prefix: string,
    res: number,
    shards: string[],
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clip: Set<string> | null,
): Promise<CellOut[]> {
    const h3Col = `h3_r${res}`
    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")
    const out = new Map<string, CellOut>()

    for (const s of shards) {
        let rows: PyramidRow[]
        try {
            rows = await readParquetFromR2<PyramidRow>(
                bucket, `${prefix}/pyramid/r${res}/${s}.parquet`,
                {
                    columns: [h3Col, "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
                    filter: { year: { $gte: yearRange[0], $lte: yearRange[1] } },
                },
            )
        } catch (e) {
            console.error(`pyramid r${res}/${s} read failed:`, e)
            continue
        }
        for (const row of rows) {
            const cellId = (row as any)[h3Col] ?? row.h3
            const hex = bigintToHex(cellId)
            if (clip && !clip.has(hex)) continue
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
    clip: Set<string> | null,
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
            const ancHex = cellToParent(baseHex, res)
            if (clip && !clip.has(ancHex)) continue
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

    return { cells, res, yearRange, severities, clipPolygon }
}
