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
 *  Memory shape: shards are processed **sequentially**, one parquet
 *  parse at a time. Per shard we filter rows + fold into the running
 *  cell-map, then drop the parsed rows. Peak memory ≈ one shard's
 *  parsed batch + the output Map. Workers' 128MB cap is the constraint.
 *  An earlier `Promise.all`-everything approach blew that on r10/r11
 *  multi-county queries.
 *
 *  Both paths return the same JSON shape:
 *
 *      {
 *        res: number,
 *        year_range: [number, number],
 *        cells: [{ h3, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs }]
 *      }
 */
import { cellToParent, polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS } from "h3-js"
import { rangesForCovering, type CellRange } from "./h3-range"
import { loadManifest } from "./manifest"
import { readParquetFromR2 } from "./parquet"

type Bbox = [number, number, number, number]
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
    bbox: Bbox
    res: number
    yearRange?: [number, number]
    severities?: Set<"f" | "i" | "p">
    /** Optional polygon to clip the response to. Cells whose center is
     *  not in the polygon are dropped. Use case: a county/muni admin
     *  boundary so the embedded map for `/c/hudson` doesn't show NYC
     *  hexes spilling out of the bbox. */
    clipPolygon?: LonLatPolygon
}

function bigintToHex(b: bigint | number): string {
    return (typeof b === "bigint" ? b : BigInt(b)).toString(16).padStart(15, "0")
}

/** Polygon ring (counter-clockwise) for an axis-aligned bbox `[w,s,e,n]`,
 *  in `[lat, lng]` order (h3-js's non-GeoJSON convention). */
function bboxToLatLngRing([w, s, e, n]: Bbox): [number, number][] {
    return [[s, w], [s, e], [n, e], [n, w], [s, w]]
}

/** Convert a GeoJSON-style `[lon, lat]` ring to h3-js's `[lat, lon]`. */
function lonLatToLatLng(ring: LonLatPolygon): [number, number][] {
    return ring.map(([lon, lat]) => [lat, lon])
}

/** Shard cells (`shard_res` parents) that intersect the requested bbox. */
function intersectingShards(
    bbox: Bbox,
    shardRes: number,
    shardCells: string[],
): string[] {
    const polygon = bboxToLatLngRing(bbox)
    const cover = new Set(
        polygonToCellsExperimental(polygon, shardRes, POLYGON_TO_CELLS_FLAGS.containmentOverlapping),
    )
    return shardCells.filter(s => cover.has(s))
}

/** Build a hyparquet filter for `(h3_r{base} BETWEEN lo AND hi) OR ...`
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
    const { bbox, res } = req
    const yearRange = req.yearRange ?? manifest.year_range
    const sevSet = req.severities  // undefined ⇒ all

    if (res < 0 || res > manifest.base_res) {
        throw new HttpError(400, `res ${res} out of range [0, ${manifest.base_res}]`)
    }

    const usePyramid = res < manifest.base_res && manifest.pyramid_levels.includes(res)
    const shards = intersectingShards(bbox, manifest.shard_res, manifest.shard_cells)
    const clip = clipCovering(req.clipPolygon, res)

    if (usePyramid) {
        const cells = await queryPyramid(bucket, prefix, res, shards, bbox, yearRange, sevSet, clip)
        return {
            res,
            year_range: yearRange,
            data_version: manifest.data_version,
            source: "pyramid",
            cells,
        }
    }
    const cells = await queryRaw(bucket, prefix, manifest, res, shards, bbox, yearRange, sevSet, clip)
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
    bbox: Bbox,
    yearRange: [number, number],
    severities: Set<"f" | "i" | "p"> | undefined,
    clip: Set<string> | null,
): Promise<CellOut[]> {
    const polygon = bboxToLatLngRing(bbox)
    const bboxCovering = new Set(
        polygonToCellsExperimental(polygon, res, POLYGON_TO_CELLS_FLAGS.containmentOverlapping),
    )
    // Pre-intersect bbox covering with the clip polygon (if any) so the
    // per-row filter does a single Set lookup instead of two.
    const allowed: Set<string> = clip
        ? new Set([...bboxCovering].filter(c => clip.has(c)))
        : bboxCovering
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
            if (!allowed.has(hex)) continue
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
        // `rows` falls out of scope at next loop iter; the parsed batch
        // is collectible. Holding `out` (one entry per visible cell) is
        // the only carryover.
    }
    return [...out.values()]
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
    clip: Set<string> | null,
): Promise<CellOut[]> {
    const baseRes = manifest.base_res
    const polygon = bboxToLatLngRing(bbox)
    const covering = polygonToCellsExperimental(
        polygon, res, POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
    )
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

    return { bbox: [w, s, e, n], res, yearRange, severities, clipPolygon }
}
