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
    cellToBoundary, polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS,
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

type Manifest = {
    schema_version: number
    data_version: string
    base_res: number
    shard_res: number
    pyramid_levels: number[]
    year_range: [number, number]
    shard_cells: string[]
}

export type CellsApiPlan = {
    kind: "hex"
    res: number
    source: "pyramid" | "raw"
    reason: string
    cellCount?: number
    /** Number of shards that contributed to this response. */
    shardCount?: number
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
 *  (lossless: parent count = sum of children). 30k chosen because the
 *  renderer handles 25k+ smoothly (verified at z=10 statewide). */
export const CELLS_BUDGET = 30000

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
): string {
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const params = new URLSearchParams({
        cells: shard,
        res: String(res),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
    })
    if (polygonStr) params.set("polygon", polygonStr)
    return `${CELLS_API_BASE}/v1/cells?${params}`
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

    const pick = useMemo(() => {
        if (!filter) return null
        if (filter.resOverride != null) {
            return { res: clamp(filter.resOverride), reason: `override r${filter.resOverride}` }
        }
        // Pick purely from zoom — the consumer coarsens post-fetch if
        // the actual cell count exceeds CELLS_BUDGET.
        const targetRes = pickHexResolutionForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat)
        const res = clamp(targetRes)
        return { res, reason: `zoom r${targetRes}` }
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride])

    // Shard set (which r4 cells to fetch) and worker `polygon=` arg are
    // computed separately so that small pans don't thrash the per-shard
    // URL cache.
    //   - Shard *selection* uses `clipPolygon ∩ snappedBbox` (scoped)
    //     or just `snappedBbox` (statewide), so we don't fetch shards
    //     far outside the visible region. Snapped to a 0.25° grid so
    //     sub-grid pans don't change the shard set.
    //   - Worker `polygon=` arg is *scope-stable*: full clipPolygon for
    //     scoped views, omitted for statewide. URL is invariant across
    //     all pans within a scope, so per-shard cache hits ~always once
    //     warmed. Cost: worker may return a few extra cells per shard
    //     just outside the viewport (still bounded by the shard's own
    //     extent ≈ 5000 km²), but these are tiny vs. an 8-9s cold fetch.
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
    const shardSet = useMemo(() => {
        if (!filter || !manifest || !snappedBbox) return null
        const known = new Set(manifest.shard_cells)
        let shardRegion: [number, number][]  // [lon, lat], used only for shard selection
        if (usingPoly) {
            shardRegion = clipPolygonToBbox(filter.clipPolygon!, snappedBbox)
            if (shardRegion.length < 3) return { shards: [], polygonStr: null as string | null }
        } else {
            shardRegion = bboxToLonLatRing(snappedBbox)
        }
        const shards = shardsForRegion(lonLatToLatLng(shardRegion), manifest.shard_res, known)
        const polygonStr = usingPoly ? encodePolygon(filter.clipPolygon!) : null
        return { shards, polygonStr }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manifest, usingPoly, filter?.clipPolygon, bboxKey])

    const shardsKey = useMemo(() => {
        if (!filter || !shardSet || !pick) return null
        const { shards, polygonStr } = shardSet
        if (shards.length === 0) return { shards: [], urls: [] as string[], polygonStr: null as string | null }
        const urls = shards.map(s => buildShardUrl(s, pick.res, filter, polygonStr))
        return { shards, urls, polygonStr }
        // `pick.res` is the only field of `pick` that affects URLs; using
        // the primitive avoids re-running on every drag frame (where `pick`
        // gets a new object ref but the same `res`).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shardSet, pick?.res, filter?.yearRange, filter?.severities])

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
                // Concat per-shard cells; shards partition the cell
                // space at `shard_res`, so descendant cells at finer
                // res are unique per shard — no merge needed.
                const allCells: CellRow[] = []
                let source: "pyramid" | "raw" = "pyramid"
                for (const r of responses) {
                    if (r.source === "raw") source = "raw"
                    for (const c of r.cells) allCells.push(c)
                }
                const data = cellsToStackedHex(allCells)
                const p = pickRef.current ?? pickAtFire
                setState({
                    urls, data, status: "ready",
                    plan: {
                        kind: "hex", res: p.res, source,
                        reason: `${source} · ${p.reason} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`,
                        cellCount: data.length, shardCount: urls.length,
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
