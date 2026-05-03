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
import { useEffect, useMemo, useState } from "react"
import {
    cellToBoundary, getHexagonAreaAvg, polygonToCellsExperimental,
    POLYGON_TO_CELLS_FLAGS, UNITS,
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

const MAX_PYRAMID_RES = 11
const MIN_PYRAMID_RES = 6

/** Refetch debounce in ms. The viewport debounce coalesces a drag's
 *  worth of changes into one shard-set computation. Per-shard fetches
 *  are still independently cached, so a small pan that crosses a
 *  shard boundary only pays for the new shard. */
const DEBOUNCE_MS = 250

/** Soft cap on cells-per-response. Picker chooses the finest res where
 *  `area / hex_area ≤ CELLS_CAP`. Per-shard responses each respect
 *  this implicitly because shards are smaller than NJ; the cap is
 *  enforced against the *full visible area*. */
const CELLS_CAP = 12000

function bboxAreaKm2([w, s, e, n]: Bbox): number {
    const lat = (s + n) / 2
    const dLat = (n - s) * 111
    const dLon = (e - w) * 111 * Math.cos((lat * Math.PI) / 180)
    return Math.max(0, dLat * dLon)
}

function polygonAreaKm2(ring: [number, number][]): number {
    if (ring.length < 3) return 0
    const lat0 = ring.reduce((s, [, la]) => s + la, 0) / ring.length
    const k = Math.cos((lat0 * Math.PI) / 180)
    let a = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        a += (xj * k - xi * k) * (yi + yj)
    }
    return Math.abs(a / 2) * 111 * 111
}

function pickResForArea(areaKm2: number, targetRes: number): { res: number; reason: string } {
    if (areaKm2 <= 0) return { res: clamp(targetRes), reason: "fallback (area=0)" }
    let best = MIN_PYRAMID_RES
    for (let r = MIN_PYRAMID_RES; r <= MAX_PYRAMID_RES; r++) {
        const hexKm2 = getHexagonAreaAvg(r, UNITS.km2)
        const maxCells = areaKm2 / hexKm2
        if (maxCells <= CELLS_CAP) best = r
        else break
    }
    const targetClamped = clamp(targetRes)
    const capped = Math.min(best, targetClamped)
    let reason: string
    if (best < targetClamped) reason = `area cap r${best} (zoom wanted r${targetRes})`
    else if (best > targetClamped) reason = `zoom r${targetClamped} (area allows r${best})`
    else reason = `r${capped} ${areaKm2.toFixed(0)}km² ≤ ${CELLS_CAP}-cell cap`
    return { res: capped, reason }
}

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

function bboxToLatLngRing([w, s, e, n]: Bbox): [number, number][] {
    return [[s, w], [s, e], [n, e], [n, w], [s, w]]
}

function lonLatToLatLng(ring: [number, number][]): [number, number][] {
    return ring.map(([lon, lat]) => [lat, lon])
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
        const targetRes = pickHexResolutionForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat)
        const bboxArea = bboxAreaKm2(filter.viewport)
        const polyArea = filter.clipPolygon && filter.clipPolygon.length >= 3
            ? polygonAreaKm2(filter.clipPolygon)
            : Infinity
        return pickResForArea(Math.min(bboxArea, polyArea), targetRes)
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride, filter?.clipPolygon, filter?.viewport])

    // Compute the shard list to fetch. When a clipPolygon is set
    // (county/muni scope), use it as the shard-selection region —
    // pitch=45 inflates the viewport bbox by 2-3× into neighboring
    // counties' shards, all of which would return zero polygon-clipped
    // cells. The polygon is the actual data we want, so pick shards
    // from its outline. Without a polygon, fall back to the viewport.
    const shardsKey = useMemo(() => {
        if (!filter || !manifest || !pick) return null
        const known = new Set(manifest.shard_cells)
        const usingPoly = !!(filter.clipPolygon && filter.clipPolygon.length >= 3)
        const ring = usingPoly
            ? lonLatToLatLng(filter.clipPolygon!)
            : bboxToLatLngRing(filter.viewport)
        const shards = shardsForRegion(ring, manifest.shard_res, known)
        if (shards.length === 0) return { shards: [], urls: [] as string[], polygonStr: null as string | null }
        const polygonStr = usingPoly ? encodePolygon(filter.clipPolygon!) : null
        const urls = shards.map(s => buildShardUrl(s, pick.res, filter, polygonStr))
        return { shards, urls, polygonStr }
    }, [filter, manifest, pick])

    const [state, setState] = useState<{
        urls: string[]
        data: StackedHex[]
        status: "loading" | "ready" | "error"
        plan?: CellsApiPlan
        error?: string
    }>({ urls: [], data: [], status: "loading" })

    useEffect(() => {
        if (!shardsKey || !pick) return
        const { urls } = shardsKey
        if (urls.length === 0) {
            setState({ urls, data: [], status: "ready", plan: {
                kind: "hex", res: pick.res, source: "pyramid",
                reason: `${pick.reason} · 0 shards`, cellCount: 0, shardCount: 0,
            } })
            return
        }
        let cancelled = false
        const reason = pick.reason

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
                setState({
                    urls, data, status: "ready",
                    plan: {
                        kind: "hex", res: pick.res, source,
                        reason: `${source} · ${reason} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`,
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
    }, [shardsKey, pick])

    if (state.status === "ready") return { status: "ready", data: state.data, plan: state.plan! }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", data: state.data, plan: state.plan }
    return { status: "loading", data: state.data.length > 0 ? state.data : undefined, plan: state.plan }
}
