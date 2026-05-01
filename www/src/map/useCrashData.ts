/** Client-side data loader for the crash map.
 *
 *  Reads parquet shards via hyparquet with HTTP range fetches + column
 *  projection + row-group filter pushdown. Drives the v2 picker
 *  (`pickFetchPlanV2`) which returns a `FetchPlan` keyed on the visible
 *  viewport. Pages without live viewport state get a coarse statewide
 *  r6 single-file fallback.
 */
import { useEffect, useMemo, useState } from "react"
import {
    parquetReadObjects,
    asyncBufferFromUrl,
    cachedAsyncBuffer,
} from "hyparquet"
import type { Crash } from "./CrashMap"
import type { StackedHex } from "./StackedHexLayer"
import {
    type Bbox,
    type MapManifestV2,
    HEX_COLUMNS,
    POINT_COLUMNS,
    loadManifestV2,
    pickFetchPlanV2,
    shardUrlV2,
} from "./v2"

/** Re-exported for non-data consumers (year-range bounds, county bbox
 *  fits). All read-only metadata; the planner-driven fetch shape lives
 *  in `FetchPlan` (`v2.ts`). */
export type MapManifest = MapManifestV2

export type CrashFilter = {
    /** Inclusive year range. */
    yearRange: [number, number]
    /** County codes to include (empty = all). */
    ccs?: number[]
    /** Municipality code (requires exactly one cc). */
    mc?: number
    /** Severity subset. Default all that are in the manifest. */
    severities?: Set<"f" | "i" | "p">
    /** Visible viewport bbox `[w,s,e,n]`. Optional: when omitted the
     *  picker returns the r6 single-file as a no-viewport fallback
     *  (cheap statewide aggregate, ~50 KB after pushdown). */
    viewport?: Bbox
    /** Center latitude (for meters-per-pixel). Optional alongside viewport. */
    viewportLat?: number
    /** Current zoom level. Optional alongside viewport. */
    zoom?: number
    /** Target H3 cell pixel size driving prebin resolution choice.
     *  Optional alongside viewport. */
    hexPxTarget?: number
}

// Small in-memory cache of parsed shards for the session, keyed by
// (url, columns, filter) so the same shard read with different
// projections / row-group filters doesn't collide.
const shardCache = new Map<string, Promise<Crash[] | HexRow[]>>()

function shardCacheKey(url: string, columns?: readonly string[], filter?: object): string {
    if (!columns && !filter) return url
    const cols = columns ? [...columns].sort().join(",") : ""
    const filt = filter ? JSON.stringify(filter) : ""
    return `${url}|${cols}|${filt}`
}

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

async function fetchParquet<T>(
    url: string,
    columns?: readonly string[],
    filter?: object,
): Promise<T[]> {
    const key = shardCacheKey(url, columns, filter)
    const cached = shardCache.get(key)
    if (cached) return cached as Promise<T[]>
    const p = (async () => {
        const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url }))
        const rows = await parquetReadObjects({
            file,
            columns: columns as string[] | undefined,
            filter: filter as any,
        })
        return rows as T[]
    })()
    shardCache.set(key, p as any)
    return p
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

/** Aggregate per-shard hex rows into the StackedHex render shape, applying
 *  cc/mc/severity/year-range filters and computing per-cell `topRoute`
 *  from the cumulative row counts. */
async function aggregateHexes(rows: HexRow[], f: CrashFilter): Promise<StackedHex[]> {
    const sevs = f.severities
    const wantF = !sevs || sevs.has("f")
    const wantI = !sevs || sevs.has("i")
    const wantP = !sevs || sevs.has("p")
    const [y0, y1] = f.yearRange
    const aggByHex = new Map<string, StackedHex>()
    const routeCounts = new Map<string, Map<string, number>>()
    for (const r of rows) {
        if (r.year < y0 || r.year > y1) continue
        if (f.ccs && f.ccs.length > 0 && !f.ccs.includes(r.cc)) continue
        if (f.mc != null && r.mc !== f.mc) continue
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
            const w = (wantF ? r.n_fatal : 0) + (wantI ? r.n_ped_inj + r.n_other_inj : 0) + (wantP ? r.n_pdo : 0)
            if (w > 0) {
                let m = routeCounts.get(r.h3)
                if (!m) { m = new Map(); routeCounts.set(r.h3, m) }
                m.set(rt, (m.get(rt) ?? 0) + w)
            }
        }
    }
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
    return kept
}

export type DataKind = "points" | "hex"

/** Load crash-map data for the given filter. `dataKind` discriminates
 *  whether `data` is raw `Crash[]` or pre-aggregated `StackedHex[]` —
 *  callers must branch on it for render. The fetch plan
 *  (`pickFetchPlanV2`) chooses among raw points / hex prebins (r6 single-
 *  file, r7/r8/r9 sharded) based on viewport + shard density. */
export function useCrashData(filter: CrashFilter | null):
    | { status: "loading"; data?: undefined; dataKind?: undefined; error?: undefined; manifest?: MapManifest; refetching?: false }
    | { status: "ready"; data: Crash[] | StackedHex[]; dataKind: DataKind; manifest: MapManifest; error?: undefined; refetching: boolean }
    | { status: "error"; error: string; data?: undefined; dataKind?: undefined; manifest?: MapManifest; refetching?: false } {
    const [manifest, setManifest] = useState<MapManifestV2 | null>(null)
    const [manifestErr, setManifestErr] = useState<string | null>(null)

    // Load v2 manifest once.
    useEffect(() => {
        loadManifestV2()
            .then(m => {
                if (m) setManifest(m)
                else setManifestErr("manifest.v2.json missing or malformed")
            })
            .catch(e => setManifestErr(String(e)))
    }, [])

    // Derive the fetch plan. Stable across pans when the visible shard
    // set doesn't change (so the resulting `filterKey` doesn't either).
    const plan = useMemo(() => {
        if (!filter || !manifest) return null
        return pickFetchPlanV2({
            viewport: filter.viewport,
            zoom: filter.zoom,
            lat: filter.viewportLat,
            severities: filter.severities ?? new Set(["f", "i"]),
            manifest,
            hexPxTarget: filter.hexPxTarget,
        })
    }, [filter, manifest])

    const filterKey = useMemo(() => {
        if (!filter || !plan) return null
        return JSON.stringify({
            kind: plan.kind,
            res: plan.kind === "hex" ? plan.res : null,
            shards: plan.shards ? [...plan.shards].sort() : null,
            yearRange: filter.yearRange,
            ccs: filter.ccs,
            mc: filter.mc,
            severities: filter.severities ? [...filter.severities].sort() : null,
        })
    }, [filter, plan])

    const [state, setState] = useState<{
        key: string | null
        data: Crash[] | StackedHex[]
        dataKind: DataKind
        status: "loading" | "ready" | "error"
        error?: string
    }>({ key: null, data: [], dataKind: "points", status: "loading" })

    useEffect(() => {
        if (!filter || !filterKey || !plan) return
        let cancelled = false
        setState(s => ({ ...s, key: filterKey, status: "loading" }))
        ;(async () => {
            try {
                const [y0, y1] = filter.yearRange
                // Year-range row-group pushdown. Both points and hex
                // shards have a `year` column with year-bounded RG stats
                // (commit `06a5b26`).
                const yearFilter = { year: { $gte: y0, $lte: y1 } }
                if (plan.kind === "points") {
                    const urls = plan.shards.map(s => shardUrlV2("points", s))
                    const batches = await Promise.all(urls.map(p =>
                        fetchParquet<Crash>(p, POINT_COLUMNS, yearFilter).catch(() => [] as Crash[]),
                    ))
                    const merged = applyPostFilters(batches.flat(), filter)
                    if (!cancelled) setState({ key: filterKey, data: merged, dataKind: "points", status: "ready" })
                } else {
                    const artifact = (plan.res === 6 ? "hex_r6" : `hex_r${plan.res}`) as "hex_r6" | "hex_r7" | "hex_r8" | "hex_r9"
                    const urls = plan.shards
                        ? plan.shards.map(s => shardUrlV2(artifact, s))
                        : [shardUrlV2(artifact, null)]
                    const batches = await Promise.all(urls.map(p =>
                        fetchParquet<HexRow>(p, HEX_COLUMNS, yearFilter).catch(() => [] as HexRow[]),
                    ))
                    const kept = await aggregateHexes(batches.flat(), filter)
                    if (!cancelled) setState({ key: filterKey, data: kept, dataKind: "hex", status: "ready" })
                }
            } catch (e) {
                if (!cancelled) {
                    setState({ key: filterKey, data: [], dataKind: "points", status: "error", error: String(e) })
                }
            }
        })()
        return () => { cancelled = true }
    }, [filterKey])

    if (manifestErr) return { status: "error", error: manifestErr }
    if (!manifest) return { status: "loading" }
    if (state.status === "loading") {
        // If we have a previous successful fetch, keep showing it while the
        // new one runs — set `refetching` so the consumer can render a
        // subtle overlay instead of hiding the map.
        if (state.data.length > 0) {
            return { status: "ready", data: state.data, dataKind: state.dataKind, manifest, refetching: true }
        }
        return { status: "loading", manifest }
    }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", manifest }
    return { status: "ready", data: state.data, dataKind: state.dataKind, manifest, refetching: false }
}
