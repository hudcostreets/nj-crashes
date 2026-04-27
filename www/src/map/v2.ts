/** Stubbed V2 client wiring for the H3 parent-cell sharding map backend.
 *
 *  Spec: `specs/map-h3-shard-rearchitecture.md`. Pipeline runs on `e`; this
 *  file is preemptive prep so the FE flips on the moment v2 data is
 *  published. Until `manifest.v2.json` exists at `MAP_BASE_URL`, the v2
 *  path is inert and `useCrashData` falls back to the v1 layout.
 *
 *  Activation: `?v2=1` URL flag enables the v2 attempt; without the flag,
 *  v2 is never queried (no extra HTTP request on every page load).
 */
import { MAP_BASE_URL } from "./config"

export type Bbox = [number, number, number, number]  // [w, s, e, n]

export type MapManifestV2 = {
    schema_version: 2
    /** H3 resolution used to shard files (typically 5). */
    shard_res: number
    point_severities: ("f" | "i" | "p")[]
    hex_severities: ("f" | "i" | "p")[]
    year_range: [number, number]
    /** Cells with non-empty data, per artifact. */
    shards: {
        points?: string[]
        hex_r7?: string[]
        hex_r8?: string[]
        hex_r9?: string[]
    }
    /** Per-shard bbox for cheap viewport-intersection (avoids
     *  client-side `cellToBoundary` on every pan). */
    shard_bboxes: Record<string, Bbox>
    row_counts?: Record<string, number>
    /** Legacy fields kept for parity with v1 manifest consumers. */
    county_bboxes?: Record<number, Bbox>
    muni_bboxes?: Record<string, Bbox>
}

export type FetchPlan =
    | { kind: "hex"; res: 6 | 7 | 8 | 9; shards: string[] | null }
    | { kind: "points"; shards: string[] }

/** Read once per session: did the user request v2? */
export function v2Enabled(): boolean {
    if (typeof window === "undefined") return false
    return new URLSearchParams(window.location.search).get("v2") === "1"
}

const MANIFEST_V2_URL = `${MAP_BASE_URL}/v2/manifest.v2.json`

/** Columns projected when fetching v2 point shards. Trims `road`/
 *  `cross_street`/`city`/`sri`/`mp`/`route` (tooltip-only) to cut bytes
 *  ~30–40%. If those become hot-path, add them here and column-stats
 *  pushdown still applies. */
export const POINT_COLUMNS = [
    "lat", "lon", "severity", "year", "dt",
    "tk", "ti", "pk", "pi", "tv",
] as const

/** Columns projected when fetching v2 hex prebins. */
export const HEX_COLUMNS = [
    "h3", "year", "cc", "mc",
    "n_fatal", "n_ped_inj", "n_other_inj", "n_pdo",
    "top_route",
] as const

let manifestV2Promise: Promise<MapManifestV2 | null> | null = null

/** Fetch v2 manifest once per session. Resolves to null when the manifest
 *  is missing (404) or malformed — caller falls back to v1 in that case. */
export function loadManifestV2(): Promise<MapManifestV2 | null> {
    if (manifestV2Promise) return manifestV2Promise
    manifestV2Promise = (async () => {
        try {
            const r = await fetch(MANIFEST_V2_URL)
            if (!r.ok) return null
            const m = (await r.json()) as MapManifestV2
            if (m?.schema_version !== 2) return null
            return m
        } catch {
            return null
        }
    })()
    return manifestV2Promise
}

/** Reset the cached promise. Test-only — production callers should not
 *  invalidate the manifest mid-session. */
export function _resetManifestV2Cache(): void {
    manifestV2Promise = null
}

/** True iff `[w0,s0,e0,n0]` and `[w1,s1,e1,n1]` overlap (closed
 *  intervals). Ignores antimeridian wrapping — NJ doesn't span it. */
export function bboxIntersects(a: Bbox, b: Bbox): boolean {
    const [w0, s0, e0, n0] = a
    const [w1, s1, e1, n1] = b
    return !(e0 < w1 || w0 > e1 || n0 < s1 || s0 > n1)
}

/** Shard cells whose stored bbox overlaps `viewport`, intersected with
 *  the artifact-specific `availableShards` list (so we never request a
 *  cell with no data for that resolution). */
export function visibleShardsV2(
    viewport: Bbox,
    manifest: MapManifestV2,
    artifact: keyof MapManifestV2["shards"],
): string[] {
    const available = manifest.shards[artifact]
    if (!available) return []
    const set = new Set(available)
    const out: string[] = []
    for (const [cell, bbox] of Object.entries(manifest.shard_bboxes)) {
        if (!set.has(cell)) continue
        if (bboxIntersects(viewport, bbox)) out.push(cell)
    }
    return out
}

/** How many viewport-pixels a single H3 cell-edge spans at the given
 *  zoom + latitude. Mirrors `pickHexResolutionForPixels` in
 *  `CrashMap.tsx`; duplicated here to keep this module dependency-light. */
function metersPerPixel(zoom: number, lat: number): number {
    return 156543.03 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, zoom)
}

/** Approximate H3 cell-edge length in meters (centroid-to-vertex). */
const H3_EDGE_METERS: Record<number, number> = {
    5: 8544.41,
    6: 3229.83,
    7: 1220.63,
    8: 461.35,
    9: 174.38,
    10: 65.91,
}

function pickHexRes(pxTarget: number, zoom: number, lat: number): number {
    const targetMeters = pxTarget * metersPerPixel(zoom, lat)
    let best = 8
    let bestDiff = Infinity
    for (const r of [6, 7, 8, 9, 10]) {
        const diff = Math.abs(Math.log2(H3_EDGE_METERS[r] / targetMeters))
        if (diff < bestDiff) {
            bestDiff = diff
            best = r
        }
    }
    return best
}

/** Pick fetch plan from viewport + zoom + filter state. Mirrors the spec's
 *  decision tree:
 *  - Zoom ≥ point threshold && visible shard count under cap → raw rows
 *    (Phase 1's exporter puts ALL severities in `points/`, so PDO-only
 *    selections also use this path.)
 *  - Otherwise → prebin at the resolution closest to a target pixel size
 */
export type PickFetchPlanArgs = {
    viewport: Bbox
    zoom: number
    /** Center latitude — for meters-per-pixel calc. */
    lat: number
    severities: Set<"f" | "i" | "p">
    manifest: MapManifestV2
    /** Pixel target driving the prebin resolution choice. Mirrors
     *  `hexPxTarget` in `CrashMap`. */
    hexPxTarget: number
    /** Above this zoom, prefer raw points when available. */
    pointZoomThreshold?: number
    /** Cap how many `points/{cell}.parquet` shards we'll fetch in a single
     *  pass. Beyond this, fall back to a prebin. Top point shards are
     *  ~8.5 MB raw; with column projection + year-range pushdown a typical
     *  fetch is ~600 KB – 2 MB. Cap = 2 keeps worst-case under ~4 MB on
     *  the dense urban corridor (Newark/Hudson). */
    maxPointShards?: number
    /** When the chosen r7/r8/r9 prebin would require more than this many
     *  shards, fall back to the r6 single-file (~400 KB raw, ~50 KB after
     *  column + year-range pushdown). 154 r7 shards across NJ ≈ 2.5 MB +
     *  3000 range GETs; r6 single-file is one parquet with a handful of
     *  range GETs. Threshold of 30 keeps city-zoom views (Newark/Hudson
     *  z12: ~12 visible shards) on fine prebins while still folding wide
     *  metro/statewide views (≥50% of NJ visible) into the single file. */
    maxHexShards?: number
}

export function pickFetchPlanV2(args: PickFetchPlanArgs): FetchPlan {
    const {
        viewport,
        zoom,
        lat,
        severities: _severities,
        manifest,
        hexPxTarget,
        pointZoomThreshold = 11,
        maxPointShards = 2,
        maxHexShards = 30,
    } = args

    if (zoom >= pointZoomThreshold) {
        const ptShards = visibleShardsV2(viewport, manifest, "points")
        if (ptShards.length > 0 && ptShards.length <= maxPointShards) {
            return { kind: "points", shards: ptShards }
        }
    }

    const desiredRes = pickHexRes(hexPxTarget, zoom, lat)
    // Snap to the closest resolution we actually publish prebins for.
    const candidates = [6, 7, 8, 9] as const
    let resolution: 6 | 7 | 8 | 9 = candidates[0]
    let bestDiff = Infinity
    for (const r of candidates) {
        const d = Math.abs(r - desiredRes)
        if (d < bestDiff) {
            bestDiff = d
            resolution = r
        }
    }
    if (resolution === 6) {
        // r6 is a single file (not sharded) per spec.
        return { kind: "hex", res: 6, shards: null }
    }
    const artifact = `hex_r${resolution}` as "hex_r7" | "hex_r8" | "hex_r9"
    const shards = visibleShardsV2(viewport, manifest, artifact)
    // High-shard-count fallback: viewport spans many r5 parents (e.g.
    // statewide view at z8) → r6 single-file is cheaper in bytes AND in
    // round-trips than fanning out across N×r7+ shards.
    if (shards.length > maxHexShards) {
        return { kind: "hex", res: 6, shards: null }
    }
    return { kind: "hex", res: resolution, shards }
}

/** Build a parquet URL for an artifact + (optional) shard cell. */
export function shardUrlV2(
    artifact: "points" | "hex_r6" | "hex_r7" | "hex_r8" | "hex_r9",
    shard: string | null,
): string {
    if (artifact === "hex_r6") return `${MAP_BASE_URL}/v2/hex-r6.parquet`
    const dir = artifact === "points" ? "points" : artifact.replace("_", "-")
    return `${MAP_BASE_URL}/v2/${dir}/${shard}.parquet`
}

/** Approximate viewport bbox from `(lat, lon, zoom)` + container size in
 *  pixels. Conservative for pitched/bearing-rotated views: returns an
 *  axis-aligned box that covers the un-pitched footprint. Pitch widens
 *  the visible area asymmetrically; the picker compensates by intersecting
 *  with shard bboxes (over-fetching is benign, under-fetching shows gaps),
 *  so we lean over-inclusive by inflating by 50% in the bearing direction. */
export function bboxFromViewport(
    lat: number,
    lon: number,
    zoom: number,
    widthPx: number,
    heightPx: number,
    pitchDeg: number = 0,
): Bbox {
    const mppx = metersPerPixel(zoom, lat)
    const halfWMeters = (mppx * widthPx) / 2
    // Pitch tips the camera forward → the visible area extends further on
    // the away side. Inflate vertically by a pitch-dependent factor.
    const pitchInflate = 1 + Math.max(0, pitchDeg) / 45
    const halfHMeters = (mppx * heightPx * pitchInflate) / 2

    const dLat = halfHMeters / 110540
    const dLon = halfWMeters / (111320 * Math.cos((lat * Math.PI) / 180))

    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}
