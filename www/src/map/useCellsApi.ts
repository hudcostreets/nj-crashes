/** Client hook for the dynamic cells API (`crashes-cells-api`).
 *
 *  **Shard-keyed.** The client computes which `shard_res` parent cells
 *  intersect the viewport (`polygonToCellsExperimental` against the
 *  manifest's `shard_cells`) and fires one request per shard in
 *  parallel. Each shard's response is cached by URL. Panning over
 *  already-fetched shards = zero new requests; you only pay for the
 *  shards newly entering the viewport.
 *
 *  Spec: `specs/cfw-cells-api.md`. Gated behind `?api=1` until the
 *  worker is deployed and parity is verified at scale.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import {
    cellToBoundary, cellToChildren, cellToParent, getResolution,
    polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS,
} from "h3-js"
import type { StackedHex } from "./StackedHexLayer"
import { CELLS_API_BASE } from "./config"
import type { Bbox } from "./v2"
import { pickHexResolutionForPixels } from "./CrashMap"

export type CellsApiFilter = {
    yearRange: [number, number]
    severities: Set<"f" | "i" | "p">
    viewport: Bbox
    viewportLat: number
    zoom: number
    hexPxTarget?: number
    /** Override resolution; bypasses `pickHexResolutionForPixels`. */
    resOverride?: number
    /** Optional GeoJSON-like polygon (`[lon, lat][]`) to clip the
     *  response to. The worker drops cells whose center isn't in the
     *  polygon — used for `/c/<county>` and `/c/<county>/<muni>` views
     *  to scope to the admin boundary instead of the (pitch-inflated)
     *  viewport bbox. */
    clipPolygon?: [number, number][]
}

type CellRow = {
    h3: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
}

type CellsResponse = {
    res: number
    year_range: [number, number]
    data_version: string
    source: "pyramid" | "raw"
    cells: CellRow[]
}

/** A pre-aggregated `(shard_res, data_res)` slice. Mirrors the
 *  worker-side `PyramidCombo`. */
export type PyramidCombo = {
    shard_res: number
    data_res: number
    shard_cells: string[]
    row_count?: number
    byte_size?: number
}

type Manifest = {
    schema_version: number
    data_version: string
    base_res: number
    shard_res: number
    pyramid_levels: number[]
    /** Multi-resolution combos (schema_version >= 4). Empty/missing on older
     *  manifests; client falls back to single shard_res. */
    pyramid_combos?: PyramidCombo[]
    year_range: [number, number]
    shard_cells: string[]
}

/** H3 cell area in km², res 0-15. Used to pick the combo whose
 *  viewport-shard-count is in target range. (Vertex-to-vertex
 *  diameter would be ~2× the edge, area = 3√3/2 × edge²). */
const H3_AREA_KM2: Record<number, number> = {
    0: 4.25e6, 1: 6.07e5, 2: 8.68e4, 3: 1.24e4, 4: 1.77e3,
    5: 2.53e2, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105,
    10: 0.015, 11: 2.15e-3, 12: 3.07e-4, 13: 4.39e-5,
}

/** Compute viewport area in km² from a (lon, lat) bbox. */
function bboxAreaKm2([w, s, e, n]: Bbox): number {
    const midLat = (s + n) / 2
    const lonKm = (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180)
    const latKm = (n - s) * 110.54
    return Math.max(0, lonKm) * Math.max(0, latKm)
}

/** Max shards in a heterogeneous cover. HTTP/2 keeps ~100 concurrent
 *  streams happy; ~25 is comfortably under that with cache hits on pan. */
const COVER_MAX_SHARDS = 30

/** Overhang threshold above which a cell is worth splitting. A cell with
 *  ≥30% of its bbox outside the viewport gets refined to children that
 *  intersect the viewport (smaller cells fit the boundary better). */
const OVERHANG_REFINE_THRESHOLD = 0.30

/** One cell of a multi-resolution cover. The pair `(shard_res, h3)`
 *  identifies a specific parquet under `pyramid/s{shard_res}_r{data_res}/`. */
export type CoverCell = {
    shard_res: number
    h3: string
}

/** Axis-aligned bbox of an H3 cell's vertex set (lon/lat). Approximate
 *  for picker math; we only need fractional overhang vs viewport, not
 *  exact area. */
function cellBbox(h3: string): Bbox {
    const boundary = cellToBoundary(h3, true)  // [lon, lat]
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
    for (const [lon, lat] of boundary) {
        if (lon < w) w = lon
        if (lon > e) e = lon
        if (lat < s) s = lat
        if (lat > n) n = lat
    }
    return [w, s, e, n]
}

function bboxIntersect(a: Bbox, b: Bbox): Bbox | null {
    const w = Math.max(a[0], b[0]), s = Math.max(a[1], b[1])
    const e = Math.min(a[2], b[2]), n = Math.min(a[3], b[3])
    if (w >= e || s >= n) return null
    return [w, s, e, n]
}

function bboxArea(b: Bbox): number {
    return (b[2] - b[0]) * (b[3] - b[1])
}

/** Fraction of a cell's bbox area outside the viewport bbox. 0 ⇒ cell
 *  is fully inside; 1 ⇒ fully outside (caller drops it). */
function cellOverhang(h3: string, vp: Bbox): number {
    const cb = cellBbox(h3)
    const total = bboxArea(cb)
    if (total === 0) return 0
    const ix = bboxIntersect(cb, vp)
    if (!ix) return 1
    return 1 - bboxArea(ix) / total
}

/** Greedy mixed-resolution cover: start from the coarsest available
 *  `shard_res` published for this `dataRes`, then iteratively split the
 *  cell with the worst viewport overhang into its 7 children (dropping
 *  those fully outside the viewport). Stops when the next split would
 *  exceed `maxShards`, no cell exceeds the overhang threshold, or the
 *  finest published `shard_res` is reached.
 *
 *  Returns an array of `{shard_res, h3}` entries. The caller fires one
 *  parquet fetch per entry, each addressed to
 *  `pyramid/s{shard_res}_r{dataRes}/{h3}.parquet`. */
function pickCover(
    combos: PyramidCombo[],
    dataRes: number,
    viewport: Bbox,
    maxShards: number,
): CoverCell[] {
    const candidates = combos
        .filter(c => c.data_res === dataRes)
        .sort((a, b) => a.shard_res - b.shard_res)  // coarsest first
    if (candidates.length === 0) return []
    const knownByRes = new Map<number, Set<string>>()
    for (const c of candidates) knownByRes.set(c.shard_res, new Set(c.shard_cells))
    const minRes = candidates[0].shard_res
    const maxRes = candidates[candidates.length - 1].shard_res

    // polygonToCells wants [lat, lng] ring; viewport is [w, s, e, n].
    const ring: [number, number][] = [
        [viewport[1], viewport[0]],
        [viewport[1], viewport[2]],
        [viewport[3], viewport[2]],
        [viewport[3], viewport[0]],
        [viewport[1], viewport[0]],
    ]
    let initial: string[]
    try {
        initial = polygonToCellsExperimental(ring, minRes, POLYGON_TO_CELLS_FLAGS.containmentOverlapping) as unknown as string[]
    } catch {
        return []
    }
    const knownMin = knownByRes.get(minRes)!
    const cover: CoverCell[] = initial.filter(h => knownMin.has(h)).map(h => ({ shard_res: minRes, h3: h }))

    // Greedy refinement.
    while (cover.length + 6 <= maxShards) {
        let worstIdx = -1
        let worstOverhang = OVERHANG_REFINE_THRESHOLD
        for (let i = 0; i < cover.length; i++) {
            if (cover[i].shard_res >= maxRes) continue
            const o = cellOverhang(cover[i].h3, viewport)
            if (o > worstOverhang) { worstOverhang = o; worstIdx = i }
        }
        if (worstIdx < 0) break
        const cell = cover[worstIdx]
        const childRes = cell.shard_res + 1
        const knownChildren = knownByRes.get(childRes)
        if (!knownChildren) break
        const children = (cellToChildren(cell.h3, childRes) as unknown as string[])
            .filter(h => knownChildren.has(h))
            .filter(h => cellOverhang(h, viewport) < 1)  // drop fully-outside
        if (children.length === 0) {
            // No useful children: parent stays. Avoid infinite loop by not retrying.
            cover[worstIdx] = { shard_res: maxRes, h3: cell.h3 }  // mark as un-refineable
            continue
        }
        cover.splice(worstIdx, 1, ...children.map(h => ({ shard_res: childRes, h3: h })))
    }
    return cover
}

export type CellsApiPlan = {
    kind: "hex"
    res: number
    source: "pyramid" | "raw"
    reason: string
    cellCount?: number
    /** Number of shards that contributed to this response. */
    shardCount?: number
    /** Heterogeneous cover the client picked for this view. The debug
     *  overlay outlines these to make the cover visible. */
    cover?: CoverCell[]
}

/** Per-shard response cache. Keyed by full URL — same shard with
 *  different (res, years, sevs, polygon) is a distinct entry. Pan over
 *  already-fetched shards = zero new requests. */
const shardCache = new Map<string, Promise<CellsResponse>>()

/** Manifest is fetched once (cells-api version is stable across a
 *  page lifetime; redeploys flip `data_version` but not `shard_*`). */
let manifestPromise: Promise<Manifest> | null = null
function loadManifest(): Promise<Manifest> {
    if (manifestPromise) return manifestPromise
    manifestPromise = fetch(`${CELLS_API_BASE}/v1/manifest`).then(async r => {
        if (!r.ok) throw new Error(`manifest fetch ${r.status}`)
        return await r.json() as Manifest
    })
    manifestPromise.catch(() => { manifestPromise = null })
    return manifestPromise
}

async function fetchShard(url: string): Promise<CellsResponse> {
    const hit = shardCache.get(url)
    if (hit) return hit
    const p = (async () => {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`cells api ${r.status}: ${await r.text().catch(() => "")}`)
        return (await r.json()) as CellsResponse
    })()
    p.catch(() => { if (shardCache.get(url) === p) shardCache.delete(url) })
    shardCache.set(url, p)
    return p
}

const MAX_PYRAMID_RES = 14
const MIN_PYRAMID_RES = 6

/** Refetch debounce in ms. The viewport debounce coalesces a drag's
 *  worth of changes into one shard-set computation. Per-shard fetches
 *  are still independently cached, so a small pan that crosses a
 *  shard boundary only pays for the new shard. */
const DEBOUNCE_MS = 250

/** Render budget — max hex bins shown on screen. The picker no longer
 *  caps based on theoretical max (`area / hex_area`); it picks res
 *  purely from zoom. The consumer (CrashMapSection) coarsens
 *  client-side via `h3 cellToParent` if a fetch comes back over budget
 *  (lossless: parent count = sum of children).
 *
 *  Bumped 30k → 60k after multi-res sharding landed: at z~10 over urban
 *  NJ the actual in-viewport r10 cell count is ~42k. 30k forced a coarsen
 *  to r9 (defeating the point of finer sharding). Deck.gl's
 *  HexagonLayer-style instanced rendering handles 100k+ smoothly. */
export const CELLS_BUDGET = 60000

/** Per-shard cap sent to the worker as `?maxCells=`. Worker walks
 *  coarser if a shard's cells would exceed this — only triggers
 *  adaptation for genuinely dense shards (e.g. urban Hudson at r10+).
 *  Splitting CELLS_BUDGET / N_shards is too tight: at N=31 every shard
 *  gets ~1k budget and most adapt unnecessarily. A flat 5k means
 *  sparse shards keep requested res; total cells across all shards is
 *  bounded by N × 5000 worst-case but realistically much less. The
 *  client coarsens the union if total still exceeds CELLS_BUDGET. */
const SHARD_MAX_CELLS = 5000

/** Statewide clip polygon — sent as the worker `polygon=` arg for
 *  views without a county/muni scope. Without it, each r4 shard returns
 *  its full ~5000 km² contents (NJ + offshore Atlantic + slices of NY/PA),
 *  ~5× more cells than the visible NJ data. NJ outline ≈ 22k km² inside a
 *  ~53k km² envelope; this is the envelope rectangle, good enough to drop
 *  most off-state shard area while staying cache-stable (it's a constant).
 *  An accurate NJ polygon would clip a few % more but isn't worth the
 *  extra polygon bytes per request. */
// CW outer ring (h3 convention; CCW is treated as a hole and explodes
// the cover at fine res).
const NJ_CLIP_POLYGON: [number, number][] = [
    [-75.6, 41.4], [-73.9, 41.4], [-73.9, 38.9], [-75.6, 38.9], [-75.6, 41.4],
]

function clamp(res: number): number {
    return Math.max(MIN_PYRAMID_RES, Math.min(MAX_PYRAMID_RES, Math.round(res)))
}

/** Compute the shard cells (`shard_res` parents) that intersect the
 *  given region. h3-js wants `[lat, lng]` rings and the `Overlapping`
 *  flag so a small region fully inside one big shard still picks it up.
 *  Filters down to cells the manifest actually has data for. */
function shardsForRegion(
    ring: [number, number][],  // [lat, lng] order
    shardRes: number,
    knownShards: Set<string>,
): string[] {
    const cover = polygonToCellsExperimental(ring, shardRes, POLYGON_TO_CELLS_FLAGS.containmentOverlapping)
    return cover.filter(c => knownShards.has(c))
}

function bboxToLonLatRing([w, s, e, n]: Bbox): [number, number][] {
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]
}

function lonLatToLatLng(ring: [number, number][]): [number, number][] {
    return ring.map(([lon, lat]) => [lat, lon])
}

/** Sutherland-Hodgman polygon-vs-axis-aligned-rectangle clip. Input ring
 *  is `[lon, lat]`, bbox is `[w, s, e, n]`. Output is the polygon clipped
 *  to the rectangle (CCW or CW, same as input; possibly empty if the
 *  polygon doesn't overlap the rectangle). The polygon is assumed to be
 *  a simple ring (no holes); the input may be open (last !== first) or
 *  closed — output is open (no implicit closing vertex).
 *
 *  Used to compute `polygon ∩ viewport_bbox`: shrinks the clip used for
 *  shard selection and the cells-api `polygon=` param when the user has
 *  zoomed into part of a county/muni, so we fetch only the visible
 *  region instead of the full scope. */
function clipPolygonToBbox(
    poly: [number, number][],
    [w, s, e, n]: Bbox,
): [number, number][] {
    if (poly.length < 3) return []
    type Edge = { axis: 0 | 1; inside: (v: number) => boolean; intersect: (a: [number, number], b: [number, number]) => [number, number] }
    const edges: Edge[] = [
        { axis: 0, inside: v => v >= w, intersect: (a, b) => intersectAt(a, b, 0, w) },
        { axis: 0, inside: v => v <= e, intersect: (a, b) => intersectAt(a, b, 0, e) },
        { axis: 1, inside: v => v >= s, intersect: (a, b) => intersectAt(a, b, 1, s) },
        { axis: 1, inside: v => v <= n, intersect: (a, b) => intersectAt(a, b, 1, n) },
    ]
    let output = poly
    for (const { axis, inside, intersect } of edges) {
        if (output.length === 0) return []
        const input = output
        output = []
        for (let i = 0; i < input.length; i++) {
            const cur = input[i]
            const prev = input[(i - 1 + input.length) % input.length]
            const curIn = inside(cur[axis])
            const prevIn = inside(prev[axis])
            if (curIn) {
                if (!prevIn) output.push(intersect(prev, cur))
                output.push(cur)
            } else if (prevIn) {
                output.push(intersect(prev, cur))
            }
        }
    }
    return output
}

function intersectAt(
    a: [number, number], b: [number, number], axis: 0 | 1, val: number,
): [number, number] {
    const denom = b[axis] - a[axis]
    if (denom === 0) return [a[0], a[1]]
    const t = (val - a[axis]) / denom
    return axis === 0
        ? [val, a[1] + t * (b[1] - a[1])]
        : [a[0] + t * (b[0] - a[0]), val]
}

/** Encode a polygon (`[lon, lat][]`) as flat `lon,lat,...` rounded to
 *  4 decimals (~10m). County outlines are 50–500 verts → 1–5KB. */
function encodePolygon(poly: [number, number][]): string {
    return poly.flatMap(([lon, lat]) => [lon.toFixed(4), lat.toFixed(4)]).join(",")
}

function buildShardUrl(
    shard: string, res: number, filter: CellsApiFilter, polygonStr: string | null,
    maxCells: number, shardRes?: number,
): string {
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const params = new URLSearchParams({
        cells: shard,
        res: String(res),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
    })
    // Combo path skips `maxCells` (combo was pre-picked to fit budget);
    // legacy path needs it for worker-side adaptive coarsening.
    if (shardRes != null) params.set("shard_res", String(shardRes))
    else params.set("maxCells", String(maxCells))
    if (polygonStr) params.set("polygon", polygonStr)
    return `${CELLS_API_BASE}/v1/cells?${params}`
}

/** Aggregate finer-res cells into their res-`targetRes` parents. Used
 *  to normalize cross-shard responses when the worker's adaptive res
 *  picked different levels per shard (rare — only when shard data
 *  densities diverge enough to straddle a budget boundary). */
function rollupCellsToRes(cells: CellRow[], targetRes: number): CellRow[] {
    const out = new Map<string, CellRow>()
    for (const c of cells) {
        const sr = getResolution(c.h3)
        if (sr <= targetRes) { out.set(c.h3, c); continue }
        const ph = cellToParent(c.h3, targetRes)
        let p = out.get(ph)
        if (!p) {
            p = { h3: ph, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
            out.set(ph, p)
        }
        p.n_fatal += c.n_fatal
        p.n_inj_ped += c.n_inj_ped
        p.n_inj_other += c.n_inj_other
        p.n_pdo += c.n_pdo
        p.n_vehs += c.n_vehs
    }
    return [...out.values()]
}

function cellsToStackedHex(cells: CellRow[]): StackedHex[] {
    const out: StackedHex[] = []
    for (const c of cells) {
        const total = c.n_fatal + c.n_inj_ped + c.n_inj_other + c.n_pdo
        if (total === 0) continue
        const boundary = cellToBoundary(c.h3, true)
        let lon = 0, lat = 0
        for (const [ln, la] of boundary) { lon += ln; lat += la }
        out.push({
            h3: c.h3,
            center: [lon / boundary.length, lat / boundary.length],
            fatal: c.n_fatal,
            pedInj: c.n_inj_ped,
            otherInj: c.n_inj_other,
            pdo: c.n_pdo,
            total,
        })
    }
    return out
}

export function useCellsApi(filter: CellsApiFilter | null):
    | { status: "loading"; data?: StackedHex[]; plan?: CellsApiPlan; error?: undefined }
    | { status: "ready"; data: StackedHex[]; plan: CellsApiPlan; error?: undefined; refetching?: boolean }
    | { status: "error"; error: string; data?: StackedHex[]; plan?: CellsApiPlan } {

    const [manifest, setManifest] = useState<Manifest | null>(null)
    useEffect(() => {
        let cancelled = false
        loadManifest().then(m => { if (!cancelled) setManifest(m) }).catch(() => {})
        return () => { cancelled = true }
    }, [])

    // Snap viewport to a 0.25° grid before picking the cover. Sub-grid
    // pans don't change the cover → per-shard URL cache hits stay warm.
    const usingPoly = !!(filter?.clipPolygon && filter.clipPolygon.length >= 3)
    const snappedBbox = useMemo<Bbox | null>(() => {
        if (!filter) return null
        const [w, s, e, n] = filter.viewport
        const G = 4  // 0.25° grid
        return [
            Math.floor(w * G) / G,
            Math.floor(s * G) / G,
            Math.ceil(e * G) / G,
            Math.ceil(n * G) / G,
        ] as Bbox
    }, [filter?.viewport])
    const bboxKey = snappedBbox ? snappedBbox.join(",") : null

    const pick = useMemo<{ res: number; cover: CoverCell[]; reason: string } | null>(() => {
        if (!filter || !manifest || !snappedBbox) return null
        const res = filter.resOverride != null
            ? clamp(filter.resOverride)
            : clamp(pickHexResolutionForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat))
        const combos = manifest.pyramid_combos ?? []
        // For county/muni scopes, clip the cover region to the admin polygon
        // ∩ snappedBbox so we don't fetch shards far outside the visible area.
        // For statewide, use the snapped bbox directly.
        let coverBbox = snappedBbox
        if (usingPoly && filter.clipPolygon) {
            const clipped = clipPolygonToBbox(filter.clipPolygon, snappedBbox)
            if (clipped.length >= 3) {
                let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
                for (const [lon, lat] of clipped) {
                    if (lon < w) w = lon
                    if (lon > e) e = lon
                    if (lat < s) s = lat
                    if (lat > n) n = lat
                }
                coverBbox = [w, s, e, n]
            }
        }
        const cover = pickCover(combos, res, coverBbox, COVER_MAX_SHARDS)
        if (cover.length === 0) {
            return { res, cover: [], reason: `r${res} · no combo for r${res}` }
        }
        // Compact reason: cells per shard_res tier.
        const tiers = new Map<number, number>()
        for (const c of cover) tiers.set(c.shard_res, (tiers.get(c.shard_res) ?? 0) + 1)
        const tierStr = [...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([sr, n]) => `s${sr}×${n}`).join(" + ")
        return { res, cover, reason: `r${res} · ${tierStr}` }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride, manifest, bboxKey, usingPoly, filter?.clipPolygon])

    // `polygonStr` for the worker `polygon=` arg is scope-stable
    // (statewide vs. county/muni outline) — invariant across pans within
    // a scope, so per-shard cache hits ~always once warmed.
    const polygonStr = useMemo<string | null>(() => {
        if (!filter) return null
        return encodePolygon(usingPoly ? filter.clipPolygon! : NJ_CLIP_POLYGON)
    }, [usingPoly, filter?.clipPolygon])

    const shardsKey = useMemo(() => {
        if (!filter || !pick || pick.cover.length === 0) {
            return { shards: [] as string[], urls: [] as string[], polygonStr: null as string | null }
        }
        // One URL per cover cell. Each cell carries its own shard_res
        // (heterogeneous cover ⇒ different parquet subdirs per cell).
        const perShardCap = SHARD_MAX_CELLS
        const urls = pick.cover.map(c => buildShardUrl(c.h3, pick.res, filter, polygonStr, perShardCap, c.shard_res))
        const shards = pick.cover.map(c => c.h3)
        return { shards, urls, polygonStr }
        // The covers themselves are stable across small pans thanks to
        // snappedBbox. Listing each primitive separately avoids drag-frame
        // churn on the array refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pick?.res, pick?.cover, polygonStr, filter?.yearRange, filter?.severities])

    const [state, setState] = useState<{
        urls: string[]
        data: StackedHex[]
        status: "loading" | "ready" | "error"
        plan?: CellsApiPlan
        error?: string
    }>({ urls: [], data: [], status: "loading" })

    // `pick` gets a new object ref every drag frame (its `reason` string
    // includes `bboxArea`, which changes on every viewport update), but
    // `pick.res` is stable across small pans and is the only field of
    // `pick` that affects URL building. Read via ref inside the effect so
    // a fresh `pick.reason` doesn't re-trigger fetches every frame.
    const pickRef = useRef(pick)
    pickRef.current = pick

    useEffect(() => {
        if (!shardsKey || !pickRef.current) return
        const { urls } = shardsKey
        const pickAtFire = pickRef.current
        if (urls.length === 0) {
            setState({ urls, data: [], status: "ready", plan: {
                kind: "hex", res: pickAtFire.res, source: "pyramid",
                reason: `${pickAtFire.reason} · 0 shards`, cellCount: 0, shardCount: 0,
                cover: pickAtFire.cover,
            } })
            return
        }
        let cancelled = false

        // Hot path: every URL already cached → resolve synchronously
        // (microtask), no debounce, no loading flicker.
        const allCached = urls.every(u => shardCache.has(u))
        const fire = async () => {
            try {
                const responses = await Promise.all(urls.map(u => fetchShard(u)))
                if (cancelled) return
                // Worker walks coarser when a shard's count would overflow
                // its budget, so different shards may return at different
                // res. Pick the coarsest returned res; any finer shards
                // get coarsened locally to match (lossless: parent count =
                // sum of children).
                let source: "pyramid" | "raw" = "pyramid"
                let minRes = Infinity
                for (const r of responses) {
                    if (r.source === "raw") source = "raw"
                    if (r.res < minRes) minRes = r.res
                }
                const finalRes = minRes === Infinity ? pickAtFire.res : minRes
                const allCells: CellRow[] = []
                for (const r of responses) {
                    if (r.res === finalRes) {
                        for (const c of r.cells) allCells.push(c)
                    } else {
                        // Aggregate finer cells up to finalRes via parent-cell rollup.
                        const rolled = rollupCellsToRes(r.cells, finalRes)
                        for (const c of rolled) allCells.push(c)
                    }
                }
                const data = cellsToStackedHex(allCells)
                const requestedRes = pickAtFire.res
                const adapted = finalRes !== requestedRes
                const reason = adapted
                    ? `${source} · ${pickAtFire.reason} · adapted r${requestedRes}→r${finalRes} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`
                    : `${source} · ${pickAtFire.reason} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`
                setState({
                    urls, data, status: "ready",
                    plan: {
                        kind: "hex", res: finalRes, source,
                        reason,
                        cellCount: data.length, shardCount: urls.length,
                        cover: pickAtFire.cover,
                    },
                })
            } catch (e) {
                if (!cancelled) setState(s => ({ ...s, urls, status: "error", error: String(e) }))
            }
        }
        if (allCached) { fire(); return () => { cancelled = true } }
        const t = setTimeout(() => {
            if (cancelled) return
            setState(s => ({ ...s, urls, status: "loading" }))
            fire()
        }, DEBOUNCE_MS)
        return () => { cancelled = true; clearTimeout(t) }
    }, [shardsKey])

    if (state.status === "ready") return { status: "ready", data: state.data, plan: state.plan! }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", data: state.data, plan: state.plan }
    return { status: "loading", data: state.data.length > 0 ? state.data : undefined, plan: state.plan }
}
