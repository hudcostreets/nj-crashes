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
import { MAP_BASE_URL } from "./config"
import {
    type Bbox,
    type MapManifestV2,
    HEX_COLUMNS,
    POINT_COLUMNS,
    loadManifestV2,
    pickFetchPlanV2,
    shardUrlV2,
    v2Enabled,
} from "./v2"

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
    /** V2 only: viewport bbox `[w,s,e,n]`. When supplied with a center
     *  `(lat, zoom, hexPxTarget)`, the v2 picker uses this to fetch only
     *  the shards intersecting the visible area. Ignored unless v2 is
     *  active. */
    viewport?: Bbox
    /** V2 only: viewport center latitude (for meters-per-pixel). */
    viewportLat?: number
    /** V2 only: current zoom level. */
    zoom?: number
    /** V2 only: target H3 cell pixel size driving prebin resolution choice. */
    hexPxTarget?: number
}

const MANIFEST_PATH = `${MAP_BASE_URL}/manifest.json`

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

function shardPathsForFilter(f: CrashFilter): string[] {
    const [y0, y1] = f.yearRange
    const years: number[] = []
    for (let y = y0; y <= y1; y++) years.push(y)
    const ccs = f.ccs && f.ccs.length > 0 ? f.ccs : null

    if (f.scale === "detail") {
        if (ccs) {
            return years.flatMap(y => ccs.map(cc => `${MAP_BASE_URL}/by-year-county/${y}-${String(cc).padStart(2, "0")}.parquet`))
        }
        return years.map(y => `${MAP_BASE_URL}/by-year/${y}.parquet`)
    }
    // r7/r8 hex aggregates
    const res = f.scale  // "r7" | "r8"
    return years.map(y => `${MAP_BASE_URL}/hex-${res}/${y}.parquet`)
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

/** Load crash-map data for the given filter. */
export function useCrashData(filter: CrashFilter | null):
    | { status: "loading"; data?: undefined; error?: undefined; manifest?: MapManifest }
    | { status: "ready"; data: Crash[] | StackedHex[]; manifest: MapManifest; error?: undefined }
    | { status: "error"; error: string; data?: undefined; manifest?: MapManifest } {
    const [manifest, setManifest] = useState<MapManifest | null>(null)
    const [manifestErr, setManifestErr] = useState<string | null>(null)
    const [manifestV2, setManifestV2] = useState<MapManifestV2 | null>(null)
    // When v2 is requested, hold off on shard fetches until the v2
    // manifest probe finishes (success → v2 path; failure → v1 fallback).
    // Without this gate, the v1 path fires immediately and v2 fires a
    // second wave once the manifest lands — double download.
    const [v2Probed, setV2Probed] = useState(!v2Enabled())

    // Load v1 manifest once.
    useEffect(() => {
        fetch(MANIFEST_PATH)
            .then(r => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json() })
            .then(setManifest)
            .catch(e => setManifestErr(String(e)))
    }, [])

    // Probe for v2 manifest when the URL flag is set. Resolves to null when
    // the file isn't published yet — until then, the v1 path stays in use.
    useEffect(() => {
        if (!v2Enabled()) return
        loadManifestV2()
            .then(m => { setManifestV2(m); setV2Probed(true) })
            .catch(() => setV2Probed(true))
    }, [])

    // V2: derive a viewport-aware fetch plan from the filter + v2 manifest.
    // When the picker returns a stable shard set across small viewport
    // moves, the resulting `v2Key` doesn't change, so no refetch.
    const v2Active = !!(manifestV2 && filter?.viewport
        && filter.viewportLat !== undefined
        && filter.zoom !== undefined && filter.hexPxTarget !== undefined)
    const v2Plan = useMemo(() => {
        if (!v2Active || !filter || !manifestV2) return null
        return pickFetchPlanV2({
            viewport: filter.viewport!,
            zoom: filter.zoom!,
            lat: filter.viewportLat!,
            severities: filter.severities ?? new Set(["f", "i"]),
            manifest: manifestV2,
            hexPxTarget: filter.hexPxTarget!,
        })
    }, [v2Active, filter, manifestV2])

    const filterKey = useMemo(() => {
        if (!filter) return null
        if (v2Active && v2Plan) {
            return JSON.stringify({
                v: 2,
                kind: v2Plan.kind,
                res: v2Plan.kind === "hex" ? v2Plan.res : null,
                shards: v2Plan.shards ? [...v2Plan.shards].sort() : null,
                yearRange: filter.yearRange,
                ccs: filter.ccs,
                mc: filter.mc,
                severities: filter.severities ? [...filter.severities].sort() : null,
            })
        }
        return JSON.stringify({
            v: 1,
            yearRange: filter.yearRange,
            ccs: filter.ccs,
            mc: filter.mc,
            severities: filter.severities ? [...filter.severities].sort() : null,
            scale: filter.scale,
        })
    }, [filter, v2Active, v2Plan])

    const [state, setState] = useState<{
        key: string | null
        data: Crash[] | StackedHex[]
        status: "loading" | "ready" | "error"
        error?: string
    }>({ key: null, data: [], status: "loading" })

    useEffect(() => {
        if (!filter || !filterKey) return
        // V2-flag-on but probe still in flight: skip this pass; the probe
        // resolution will retrigger via the filterKey change (v2Active /
        // v2Plan flip).
        if (!v2Probed) return
        let cancelled = false
        setState(s => ({ ...s, key: filterKey, status: "loading" }))
        ;(async () => {
            try {
                if (v2Active && v2Plan) {
                    const [y0, y1] = filter.yearRange
                    if (v2Plan.kind === "points") {
                        // Points shards have no `year` column but row
                        // groups are dt-sorted (each ~1 year). Convert
                        // the year range to epoch-minutes so hyparquet
                        // can prune row groups via dt min/max stats.
                        const dtMin = Math.floor(Date.UTC(y0, 0, 1) / 60_000)
                        const dtMax = Math.floor(Date.UTC(y1 + 1, 0, 1) / 60_000) - 1
                        const dtFilter = { dt: { $gte: dtMin, $lte: dtMax } }
                        const urls = v2Plan.shards.map(s => shardUrlV2("points", s))
                        const batches = await Promise.all(urls.map(p =>
                            fetchParquet<Crash>(p, POINT_COLUMNS, dtFilter).catch(() => [] as Crash[]),
                        ))
                        // Belt-and-suspenders dt guard for rows that
                        // survived in not-fully-pruned RGs, then
                        // cc/mc/severity post-filter.
                        const merged = applyPostFilters(batches.flat(), filter)
                            .filter(r => {
                                const dt = (r as any).dt as number | undefined
                                return dt === undefined || (dt >= dtMin && dt <= dtMax)
                            })
                        if (!cancelled) setState({ key: filterKey, data: merged, status: "ready" })
                    } else {
                        // Hex shards have `year` but row groups are NOT
                        // year-sorted today (each RG spans 2001-2023),
                        // so pushdown can't prune. Skip the filter and
                        // rely on `aggregateHexes`'s client-side year
                        // skip. Per-shard hex files are 50-150 KB —
                        // unfiltered fetch is fine.
                        const artifact = (v2Plan.res === 6 ? "hex_r6" : `hex_r${v2Plan.res}`) as "hex_r6" | "hex_r7" | "hex_r8" | "hex_r9"
                        const urls = v2Plan.shards
                            ? v2Plan.shards.map(s => shardUrlV2(artifact, s))
                            : [shardUrlV2(artifact, null)]
                        const batches = await Promise.all(urls.map(p =>
                            fetchParquet<HexRow>(p, HEX_COLUMNS).catch(() => [] as HexRow[]),
                        ))
                        const kept = await aggregateHexes(batches.flat(), filter)
                        if (!cancelled) setState({ key: filterKey, data: kept, status: "ready" })
                    }
                    return
                }
                // V1 path.
                const paths = shardPathsForFilter(filter)
                if (filter.scale === "detail") {
                    const batches = await Promise.all(paths.map(p =>
                        fetchParquet<Crash>(p).catch(() => [] as Crash[]),
                    ))
                    const merged = applyPostFilters(batches.flat(), filter)
                    if (!cancelled) setState({ key: filterKey, data: merged, status: "ready" })
                } else {
                    const batches = await Promise.all(paths.map(p =>
                        fetchParquet<HexRow>(p).catch(() => [] as HexRow[]),
                    ))
                    const kept = await aggregateHexes(batches.flat(), filter)
                    if (!cancelled) setState({ key: filterKey, data: kept, status: "ready" })
                }
            } catch (e) {
                if (!cancelled) {
                    setState({ key: filterKey, data: [], status: "error", error: String(e) })
                }
            }
        })()
        return () => { cancelled = true }
    }, [filterKey, v2Probed])

    if (manifestErr) return { status: "error", error: manifestErr }
    if (!manifest) return { status: "loading" }
    if (state.status === "loading") return { status: "loading", manifest }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", manifest }
    return { status: "ready", data: state.data, manifest }
}
