/** Client-side data loader for the crash map.
 *
 *  Reads parquet shards via hyparquet with HTTP range fetches + column
 *  projection + row-group filter pushdown. Picks which shards to load based
 *  on the active filter (counties, year range) and the current mode (point
 *  vs hex aggregate).
 */
import { useEffect, useMemo, useState } from "react"
import {
    parquetReadObjects,
    asyncBufferFromUrl,
    cachedAsyncBuffer,
} from "hyparquet"
import type { Crash } from "./CrashMap"
import type { StackedHex } from "./StackedHexLayer"

export type MapManifest = {
    schema_version: 1
    point_severities: string[]
    hex_severities: string[]
    year_range: [number, number]
    total_rows: number
    point_rows: number
    by_geocode_src: Record<string, number>
    per_year: Record<string, number>
    per_year_county: Record<string, number>
    hex_aggregates: Record<string, Record<string, number>>
    county_bboxes?: Record<number, [number, number, number, number]>
    muni_bboxes?: Record<string, [number, number, number, number]>
}

export type CrashFilter = {
    /** Inclusive year range. */
    yearRange: [number, number]
    /** County codes to include (empty = all). */
    ccs?: number[]
    /** Municipality code (requires exactly one cc). */
    mc?: number
    /** Severity subset. Default all that are in the manifest. */
    severities?: Set<"f" | "i" | "p">
    /** Which layer to load: raw rows (scatter/heatmap) or pre-aggregated hex. */
    scale: "detail" | "r8" | "r7"
}

const MANIFEST_PATH = "/njdot/map/manifest.json"

// Small in-memory cache of parsed shards for the session.
const shardCache = new Map<string, Promise<Crash[] | HexRow[]>>()

export type HexRow = {
    h3: string
    year: number
    cc: number
    mc: number | null
    n_fatal: number
    n_ped_inj: number
    n_other_inj: number
    n_pdo: number
    /** Most common `route` value among the bin's crashes; empty if unknown.
     *  Optional because older shards don't have this column. */
    top_route?: string
}

async function fetchParquet<T>(url: string, columns?: string[]): Promise<T[]> {
    const cached = shardCache.get(url)
    if (cached) return cached as Promise<T[]>
    const p = (async () => {
        const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url }))
        const rows = await parquetReadObjects({ file, columns })
        return rows as T[]
    })()
    shardCache.set(url, p as any)
    return p
}

function shardPathsForFilter(f: CrashFilter): string[] {
    const [y0, y1] = f.yearRange
    const years: number[] = []
    for (let y = y0; y <= y1; y++) years.push(y)
    const ccs = f.ccs && f.ccs.length > 0 ? f.ccs : null

    if (f.scale === "detail") {
        if (ccs) {
            return years.flatMap(y => ccs.map(cc => `/njdot/map/by-year-county/${y}-${String(cc).padStart(2, "0")}.parquet`))
        }
        return years.map(y => `/njdot/map/by-year/${y}.parquet`)
    }
    // r7/r8 hex aggregates
    const res = f.scale  // "r7" | "r8"
    return years.map(y => `/njdot/map/hex-${res}/${y}.parquet`)
}

function applyPostFilters(rows: Crash[], f: CrashFilter): Crash[] {
    let out = rows
    if (f.mc != null) out = out.filter(r => (r as any).mc === f.mc)
    if (f.severities) {
        const s = f.severities
        out = out.filter(r => s.has(r.severity))
    }
    return out
}

/** Load crash-map data for the given filter. */
export function useCrashData(filter: CrashFilter | null):
    | { status: "loading"; data?: undefined; error?: undefined; manifest?: MapManifest }
    | { status: "ready"; data: Crash[] | StackedHex[]; manifest: MapManifest; error?: undefined }
    | { status: "error"; error: string; data?: undefined; manifest?: MapManifest } {
    const [manifest, setManifest] = useState<MapManifest | null>(null)
    const [manifestErr, setManifestErr] = useState<string | null>(null)

    // Load manifest once
    useEffect(() => {
        fetch(MANIFEST_PATH)
            .then(r => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json() })
            .then(setManifest)
            .catch(e => setManifestErr(String(e)))
    }, [])

    const filterKey = useMemo(() => {
        if (!filter) return null
        return JSON.stringify({
            ...filter,
            severities: filter.severities ? [...filter.severities].sort() : null,
        })
    }, [filter])

    const [state, setState] = useState<{
        key: string | null
        data: Crash[] | StackedHex[]
        status: "loading" | "ready" | "error"
        error?: string
    }>({ key: null, data: [], status: "loading" })

    useEffect(() => {
        if (!filter || !filterKey) return
        let cancelled = false
        setState(s => ({ ...s, key: filterKey, status: "loading" }))
        ;(async () => {
            try {
                const paths = shardPathsForFilter(filter)
                if (filter.scale === "detail") {
                    const batches = await Promise.all(paths.map(p =>
                        fetchParquet<Crash>(p).catch(() => [] as Crash[]),
                    ))
                    const merged = applyPostFilters(batches.flat(), filter)
                    if (!cancelled) {
                        setState({ key: filterKey, data: merged, status: "ready" })
                    }
                } else {
                    const batches = await Promise.all(paths.map(p =>
                        fetchParquet<HexRow>(p).catch(() => [] as HexRow[]),
                    ))
                    const merged = batches.flat()
                    const sevs = filter.severities
                    const wantF = !sevs || sevs.has("f")
                    const wantI = !sevs || sevs.has("i")
                    const wantP = !sevs || sevs.has("p")
                    const aggByHex = new Map<string, StackedHex>()
                    // Per-h3 route → cumulative count (so multi-year/cc/mc shards
                    // aggregating into one hex pick the overall mode).
                    const routeCounts = new Map<string, Map<string, number>>()
                    for (const r of merged) {
                        if (filter.ccs && filter.ccs.length > 0 && !filter.ccs.includes(r.cc)) continue
                        if (filter.mc != null && r.mc !== filter.mc) continue
                        let h = aggByHex.get(r.h3)
                        if (!h) {
                            h = { h3: r.h3, center: [0, 0], fatal: 0, pedInj: 0, otherInj: 0, pdo: 0, total: 0 }
                            aggByHex.set(r.h3, h)
                        }
                        if (wantF) h.fatal += r.n_fatal
                        if (wantI) { h.pedInj += r.n_ped_inj; h.otherInj += r.n_other_inj }
                        if (wantP) h.pdo += r.n_pdo
                        const rt = (r.top_route ?? "").trim()
                        if (rt) {
                            // Per-bin row counts as the weight for its mode-route.
                            const w = (wantF ? r.n_fatal : 0) + (wantI ? r.n_ped_inj + r.n_other_inj : 0) + (wantP ? r.n_pdo : 0)
                            if (w > 0) {
                                let m = routeCounts.get(r.h3)
                                if (!m) { m = new Map(); routeCounts.set(r.h3, m) }
                                m.set(rt, (m.get(rt) ?? 0) + w)
                            }
                        }
                    }
                    // Drop hexes fully filtered out; compute totals + centers for survivors.
                    const { cellToBoundary } = await import("h3-js")
                    const kept: StackedHex[] = []
                    for (const h of aggByHex.values()) {
                        h.total = h.fatal + h.pedInj + h.otherInj + h.pdo
                        if (h.total === 0) continue
                        const boundary = cellToBoundary(h.h3, true)
                        let lon = 0, lat = 0
                        for (const [ln, la] of boundary) { lon += ln; lat += la }
                        h.center = [lon / boundary.length, lat / boundary.length]
                        const m = routeCounts.get(h.h3)
                        if (m && m.size > 0) {
                            let topR = "", topN = 0
                            for (const [r, n] of m) { if (n > topN) { topR = r; topN = n } }
                            h.topRoute = topR
                        }
                        kept.push(h)
                    }
                    if (!cancelled) {
                        setState({ key: filterKey, data: kept, status: "ready" })
                    }
                }
            } catch (e) {
                if (!cancelled) {
                    setState({ key: filterKey, data: [], status: "error", error: String(e) })
                }
            }
        })()
        return () => { cancelled = true }
    }, [filterKey])

    if (manifestErr) return { status: "error", error: manifestErr }
    if (!manifest) return { status: "loading" }
    if (state.status === "loading") return { status: "loading", manifest }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", manifest }
    return { status: "ready", data: state.data, manifest }
}
