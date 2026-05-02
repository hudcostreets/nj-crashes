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
import { cellToBoundary } from "h3-js"
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

/** Pyramid resolutions the worker has built (must match the manifest's
 *  `pyramid_levels`). The client-side picker can produce res values up
 *  to base_res (14); res > 11 forces the worker into a raw fallback
 *  that today blows the 128MB Workers memory cap for non-tiny bboxes.
 *  And even res 10–11 over a multi-county bbox (pitch=45 inflates the
 *  requested rect well beyond the on-screen footprint) blows up.
 *
 *  Cap conservatively at r9 — verified statewide-safe via direct
 *  worker curls — until either the pyramid path streams shards (vs.
 *  in-memory load + filter) or the FE shrinks the bbox it asks for.
 *  Picker still emits any int [4..14]; the cap clamps to [6..9].
 *  Filed as a follow-up; see `specs/cfw-cells-api.md`. */
const MAX_PYRAMID_RES = 9
const MIN_PYRAMID_RES = 6
function clampRes(res: number): number {
    return Math.max(MIN_PYRAMID_RES, Math.min(MAX_PYRAMID_RES, Math.round(res)))
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
    | { status: "loading"; data?: undefined; plan?: CellsApiPlan; error?: undefined }
    | { status: "ready"; data: StackedHex[]; plan: CellsApiPlan; error?: undefined }
    | { status: "error"; error: string; data?: undefined; plan?: CellsApiPlan } {
    const res = useMemo(() => {
        if (!filter) return null
        const raw = filter.resOverride != null
            ? filter.resOverride
            : pickHexResolutionForPixels(filter.zoom, filter.viewportLat, filter.hexPxTarget ?? 1.2)
        return clampRes(raw)
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride])

    const url = useMemo(() => {
        if (!filter || res == null) return null
        return buildUrl(filter, res)
    }, [filter, res])

    const [state, setState] = useState<{
        url: string | null
        data: StackedHex[]
        status: "loading" | "ready" | "error"
        plan?: CellsApiPlan
        error?: string
    }>({ url: null, data: [], status: "loading" })

    useEffect(() => {
        if (!url || res == null) return
        let cancelled = false
        setState(s => ({ ...s, url, status: "loading" }))
        ;(async () => {
            try {
                const resp = await fetchCells(url)
                if (cancelled) return
                const data = cellsToStackedHex(resp.cells)
                setState({
                    url,
                    data,
                    status: "ready",
                    plan: {
                        kind: "hex",
                        res: resp.res,
                        source: resp.source,
                        reason: `cells-api ${resp.source}`,
                        cellCount: resp.cells.length,
                    },
                })
            } catch (e) {
                if (!cancelled) {
                    setState({ url, data: [], status: "error", error: String(e) })
                }
            }
        })()
        return () => { cancelled = true }
    }, [url, res])

    if (state.status === "ready") return { status: "ready", data: state.data, plan: state.plan! }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", plan: state.plan }
    return { status: "loading", plan: state.plan }
}
