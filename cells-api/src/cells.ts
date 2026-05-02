/** `/v1/cells` request handler.
 *
 *  Two query paths:
 *  - **Pyramid**: `res < base_res` and a pyramid for `res` exists. Fetch
 *    the small per-resolution rollup parquets for the shards intersecting
 *    `bbox`, filter to the h3 covering + year range + severities, group
 *    by h3 cell.
 *  - **Raw fallback**: requested resolution >= base_res, or pyramid
 *    missing for `res`. Fetch raw shards under `raw/h3_r{base}/`,
 *    filter by base-res descendant ranges (parquet RG pruning), then
 *    aggregate up to `res` via `cellToParent`.
 *
 *  Both paths return the same JSON shape:
 *
 *      {
 *        res: number,
 *        year_range: [number, number],
 *        cells: [{ h3, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs?, year? }]
 *      }
 */
import { cellToParent, polygonToCells } from "h3-js"
import { rangesForCovering, type CellRange } from "./h3-range"
import { loadManifest } from "./manifest"
import { readParquetFromR2 } from "./parquet"

type Bbox = [number, number, number, number]

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
    h3: bigint | number  // worker accepts the column under either `h3_r{N}` or a normalized alias
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
    bbox: Bbox
    res: number
    yearRange?: [number, number]
    severities?: Set<"f" | "i" | "p">
}

function bigintToHex(b: bigint | number): string {
    return (typeof b === "bigint" ? b : BigInt(b)).toString(16).padStart(15, "0")
}

/** Polygon ring (counter-clockwise) for an axis-aligned bbox `[w,s,e,n]`. */
function bboxToPolygon([w, s, e, n]: Bbox): [number, number][] {
    return [[s, w], [s, e], [n, e], [n, w], [s, w]]
}

/** Shard cells (`shard_res` parents) that intersect the requested bbox.
 *  Uses the manifest's full shard list — the bbox→shard intersection is
 *  computed via h3 covering at `shard_res` and intersecting with the
 *  shard list (so we never request a shard with no data). */
function intersectingShards(
    bbox: Bbox,
    shardRes: number,
    shardCells: string[],
): string[] {
    const polygon = bboxToPolygon(bbox)
    const cover = new Set(polygonToCells(polygon, shardRes))
    return shardCells.filter(s => cover.has(s))
}

/** Build a hyparquet filter object expressing
 *  `(h3_r{base} BETWEEN lo AND hi) OR ...` across the merged ranges,
 *  AND year ∈ year_range. */
function buildRawFilter(
    h3Col: string,
    ranges: CellRange[],
    yearRange?: [number, number],
): object {
    const orClauses = ranges.map(r => ({
        [h3Col]: { $gte: r.lo, $lte: r.hi },
    }))
    const f: any = orClauses.length === 1 ? orClauses[0] : { $or: orClauses }
    if (yearRange) {
        const [y0, y1] = yearRange
        return { $and: [f, { year: { $gte: y0, $lte: y1 } }] }
    }
    return f
}

/** Aggregate a list of partial cell records (one per row, per shard)
 *  into the final per-cell totals. */
function mergeCells(rows: { h3: string; n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs?: number }[]): CellOut[] {
    const out = new Map<string, CellOut>()
    for (const r of rows) {
        let c = out.get(r.h3)
        if (!c) {
            c = { h3: r.h3, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
            out.set(r.h3, c)
        }
        c.n_fatal += r.n_fatal
        c.n_inj_ped += r.n_inj_ped
        c.n_inj_other += r.n_inj_other
        c.n_pdo += r.n_pdo
        c.n_vehs += r.n_vehs ?? 0
    }
    return [...out.values()]
}

export async function handleCellsRequest(
    bucket: R2Bucket,
    prefix: string,
    req: CellsRequest,
): Promise<CellsResponse> {
    const manifest = await loadManifest(bucket, prefix)
    const { bbox, res } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities  // undefined ⇒ all

    if (res < 0 || res > manifest.base_res) {
        throw new HttpError(400, `res ${res} out of range [0, ${manifest.base_res}]`)
    }

    const usePyramid = res < manifest.base_res && manifest.pyramid_levels.includes(res)
    const shards = intersectingShards(bbox, manifest.shard_res, manifest.shard_cells)

    if (usePyramid) {
        const cells = await queryPyramid(bucket, prefix, manifest, res, shards, bbox, yearRange, sevSet)
        return {
            res,
            year_range: yearRange,
            data_version: manifest.data_version,
            source: "pyramid",
            cells,
        }
    }
    const cells = await queryRaw(bucket, prefix, manifest, res, shards, bbox, yearRange, sevSet)
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
    manifest: { base_res: number },
    res: number,
    shards: string[],
    bbox: Bbox,
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
): Promise<CellOut[]> {
    const polygon = bboxToPolygon(bbox)
    const covering = new Set(polygonToCells(polygon, res))
    const h3Col = `h3_r${res}`

    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")

    const batches = await Promise.all(shards.map(s =>
        readParquetFromR2<PyramidRow>(bucket, `${prefix}/pyramid/r${res}/${s}.parquet`, {
            columns: [h3Col, "year", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
            filter: { year: { $gte: yearRange[0], $lte: yearRange[1] } },
        }).catch(() => [] as PyramidRow[]),
    ))
    const partials: { h3: string; n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs?: number }[] = []
    for (const batch of batches) {
        for (const row of batch) {
            const cellId = (row as any)[h3Col] ?? row.h3
            const hex = bigintToHex(cellId)
            if (!covering.has(hex)) continue
            partials.push({
                h3: hex,
                n_fatal: wantF ? row.n_fatal : 0,
                n_inj_ped: wantI ? row.n_inj_ped : 0,
                n_inj_other: wantI ? row.n_inj_other : 0,
                n_pdo: wantP ? row.n_pdo : 0,
                n_vehs: row.n_vehs ?? 0,
            })
        }
    }
    return mergeCells(partials)
}

async function queryRaw(
    bucket: R2Bucket,
    prefix: string,
    manifest: { base_res: number },
    res: number,
    shards: string[],
    bbox: Bbox,
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
): Promise<CellOut[]> {
    const baseRes = manifest.base_res
    const polygon = bboxToPolygon(bbox)
    const covering = polygonToCells(polygon, res)
    const ranges = rangesForCovering(
        covering.map(c => BigInt(`0x${c}`)),
        res,
        baseRes,
    )
    const h3Col = `h3_r${baseRes}`
    const filter = buildRawFilter(h3Col, ranges, yearRange)

    const wantF = !severities || severities.has("f")
    const wantI = !severities || severities.has("i")
    const wantP = !severities || severities.has("p")

    const batches = await Promise.all(shards.map(s =>
        readParquetFromR2<RawRow>(bucket, `${prefix}/raw/h3_r${baseRes}/${s}.parquet`, {
            columns: [h3Col, "year", "severity", "tk", "ti", "pk", "pi", "tv"],
            filter,
        }).catch(() => [] as RawRow[]),
    ))

    const partials: { h3: string; n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number; n_vehs: number }[] = []
    for (const batch of batches) {
        for (const row of batch) {
            const cellId = (row as any)[h3Col] ?? row.h3_r14
            const baseHex = bigintToHex(cellId)
            const ancHex = cellToParent(baseHex, res)
            const sev = row.severity
            const fatal = sev === "f" ? 1 : 0
            const pedInj = sev === "i" ? row.pi : 0
            const otherInj = sev === "i" ? row.ti - row.pi : 0
            const pdo = sev === "p" ? 1 : 0
            partials.push({
                h3: ancHex,
                n_fatal: wantF ? fatal : 0,
                n_inj_ped: wantI ? pedInj : 0,
                n_inj_other: wantI ? otherInj : 0,
                n_pdo: wantP ? pdo : 0,
                n_vehs: row.tv ?? 0,
            })
        }
    }
    return mergeCells(partials)
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
    const bboxStr = url.searchParams.get("bbox")
    if (!bboxStr) throw new HttpError(400, "bbox is required")
    const parts = bboxStr.split(",").map(Number)
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
        throw new HttpError(400, "bbox must be 4 comma-separated numbers")
    }
    const [w, s, e, n] = parts
    if (e <= w || n <= s) throw new HttpError(400, "bbox must satisfy e>w, n>s")
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

    return { bbox: [w, s, e, n], res, yearRange, severities }
}
