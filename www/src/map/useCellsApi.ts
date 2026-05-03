/** Client hook for the dynamic cells API (`crashes-cells-api`).
 *
 *  Replaces the static-prebin ladder + manifest + per-shard fetcher with
 *  a single endpoint hit. The worker handles pyramid vs. raw selection
 *  internally, so the client just picks an integer resolution from
 *  `hexPxTarget` + `zoom` and asks for it.
 *
 *  Spec: `specs/cfw-cells-api.md`. Gated behind `?api=1` until parity is
 *  verified against the v2 client (`useCrashData`).
 */
import { useEffect, useMemo, useState } from "react"
import { cellToBoundary, getHexagonAreaAvg, UNITS } from "h3-js"
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

export type CellsApiPlan = {
    kind: "hex"
    res: number
    source: "pyramid" | "raw"
    reason: string
    cellCount?: number
    bytes?: number
}

const responseCache = new Map<string, Promise<CellsResponse>>()

function cacheKey(url: string): string {
    return url
}

async function fetchCells(url: string): Promise<CellsResponse> {
    const key = cacheKey(url)
    const hit = responseCache.get(key)
    if (hit) return hit
    const p = (async () => {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`cells api ${r.status}: ${await r.text().catch(() => "")}`)
        return (await r.json()) as CellsResponse
    })()
    // Evict the cached promise on failure so retries actually retry instead
    // of returning the same rejection forever.
    p.catch(() => { if (responseCache.get(key) === p) responseCache.delete(key) })
    responseCache.set(key, p)
    return p
}

/** Worker pyramid range. Pyramid covers r6-r11 (raw fallback at r12+ is
 *  unreliable and OOMs). MIN bounds the floor for very low zoom; MAX
 *  bounds raw fallback. The actual ceiling is set adaptively by
 *  `pickResForArea` below — too-fine res for a large bbox blows up
 *  cell counts, response size, and worker memory. */
const MAX_PYRAMID_RES = 11
const MIN_PYRAMID_RES = 6

/** Refetch debounce in ms. Pan/zoom emits many filter changes per
 *  second; we only want to fire once after the user settles. 300ms is
 *  a typical debounce for map-drag UIs (long enough to coalesce a
 *  drag, short enough to feel responsive once the user lets go). */
const DEBOUNCE_MS = 300

/** Soft cap on cells-per-response. Drives the bbox-aware res picker:
 *  pick the finest res where (area / hex_area) stays under this. This
 *  is the *bbox-coverage* upper bound; *non-empty* cells (what we
 *  actually return) are typically 40-50% of this at r10 and lower at
 *  finer res (more empty cells). 12k bound → ~4-6k actual at r10,
 *  well within renderer + Workers 128MB envelope. */
const CELLS_CAP = 12000

/** Geodesic area (km²) of an axis-aligned bbox at NJ-ish latitudes.
 *  Uses average lat for the cosine correction; a flat-earth approx
 *  good to <1% over a county-sized window. */
function bboxAreaKm2([w, s, e, n]: Bbox): number {
    const lat = (s + n) / 2
    const dLat = (n - s) * 111  // 1° lat ≈ 111 km
    const dLon = (e - w) * 111 * Math.cos((lat * Math.PI) / 180)
    return Math.max(0, dLat * dLon)
}

/** Polygon ring area (km²) via the spherical-shoelace formula, projected
 *  with a flat-earth lat-cosine correction. Same precision regime as
 *  `bboxAreaKm2`. */
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

/** Pick the finest h3 resolution where bbox-max-cells stays under
 *  `CELLS_CAP`. Falls within [MIN_PYRAMID_RES, MAX_PYRAMID_RES].
 *  `targetRes` is the zoom-driven ideal; we don't pick finer than it
 *  even if the area allows. */
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

/** Encode a polygon (`[lon, lat][]`) as a flat `lon,lat,lon,lat,...`
 *  string. Polygon vertex coords are rounded to 4 decimal places (~10m
 *  precision) to keep URLs short. County-outline polygons typically
 *  have ~50–500 vertices → ~1–5 KB encoded. */
function encodePolygon(poly: [number, number][]): string {
    return poly.flatMap(([lon, lat]) => [lon.toFixed(4), lat.toFixed(4)]).join(",")
}

function buildUrl(filter: CellsApiFilter, res: number): string {
    const [w, s, e, n] = filter.viewport
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const params = new URLSearchParams({
        bbox: [w, s, e, n].map(x => x.toFixed(5)).join(","),
        res: String(res),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
    })
    if (filter.clipPolygon && filter.clipPolygon.length >= 3) {
        params.set("polygon", encodePolygon(filter.clipPolygon))
    }
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
    const pick = useMemo(() => {
        if (!filter) return null
        if (filter.resOverride != null) {
            return { res: clamp(filter.resOverride), reason: `override r${filter.resOverride}` }
        }
        const targetRes = pickHexResolutionForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat)
        // Visible cells are bounded by min(viewport bbox, clip polygon).
        // When zoomed into a corner of a county, the bbox is much
        // smaller than the polygon — using bbox lets us pick a finer
        // res. When the viewport encompasses the polygon, the polygon
        // is tighter (drops out-of-poly cells server-side).
        const bboxArea = bboxAreaKm2(filter.viewport)
        const polyArea = filter.clipPolygon && filter.clipPolygon.length >= 3
            ? polygonAreaKm2(filter.clipPolygon)
            : Infinity
        return pickResForArea(Math.min(bboxArea, polyArea), targetRes)
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride, filter?.clipPolygon, filter?.viewport])

    const url = useMemo(() => {
        if (!filter || pick == null) return null
        return buildUrl(filter, pick.res)
    }, [filter, pick])

    const [state, setState] = useState<{
        url: string | null
        data: StackedHex[]
        status: "loading" | "ready" | "error"
        plan?: CellsApiPlan
        error?: string
    }>({ url: null, data: [], status: "loading" })

    // Debounce viewport-driven refetches: while the user pans/zooms,
    // `url` updates many times per second. Wait `DEBOUNCE_MS` of
    // stability before firing — coalesces a drag's worth of viewport
    // changes into a single request once the user releases.
    useEffect(() => {
        if (!url || !pick) return
        let cancelled = false
        const reason = pick.reason
        // Don't flicker the data layer empty during pan — keep the
        // last-rendered cells visible. The status flips to "loading"
        // only when we actually fire the request after the debounce.
        const cached = responseCache.get(url)
        if (cached) {
            // URL already cached (revisited viewport, or quick pan that
            // returned to a prior bbox) — no debounce, return immediately.
            ;(async () => {
                try {
                    const resp = await cached
                    if (cancelled) return
                    const data = cellsToStackedHex(resp.cells)
                    setState({
                        url, data, status: "ready",
                        plan: {
                            kind: "hex", res: resp.res, source: resp.source,
                            reason: `${resp.source} · ${reason}`,
                            cellCount: resp.cells.length,
                        },
                    })
                } catch (e) {
                    if (!cancelled) setState({ url, data: [], status: "error", error: String(e) })
                }
            })()
            return () => { cancelled = true }
        }
        const t = setTimeout(() => {
            if (cancelled) return
            // Don't drop prior data when refetching — keeps the map
            // populated with the last view's cells while we wait.
            setState(s => ({ ...s, url, status: "loading" }))
            ;(async () => {
                try {
                    const resp = await fetchCells(url)
                    if (cancelled) return
                    const data = cellsToStackedHex(resp.cells)
                    setState({
                        url, data, status: "ready",
                        plan: {
                            kind: "hex", res: resp.res, source: resp.source,
                            reason: `${resp.source} · ${reason}`,
                            cellCount: resp.cells.length,
                        },
                    })
                } catch (e) {
                    if (!cancelled) setState({ url, data: [], status: "error", error: String(e) })
                }
            })()
        }, DEBOUNCE_MS)
        return () => { cancelled = true; clearTimeout(t) }
    }, [url, pick])

    if (state.status === "ready") return { status: "ready", data: state.data, plan: state.plan! }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", data: state.data, plan: state.plan }
    return { status: "loading", data: state.data.length > 0 ? state.data : undefined, plan: state.plan }
}
