/** Map-manifest client (v2 layout) + viewport bbox helper.
 *
 *  What survives of the H3-era "map v2" R2-direct fetch stack: the
 *  manifest loader (year-range bounds, county/muni bboxes, geocode-src
 *  breakdowns still drive non-spatial UI) and `bboxFromViewport`. The
 *  fetch planner (`pickFetchPlanV2`, point/hex shard plans) was dead
 *  code after the cells-api worker took over data fetching, and was
 *  removed with the H3 grid (`specs/h3-removal.md`).
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
    /** Resolutions for which a single-file `hex-r{N}.parquet` exists at the
     *  manifest's base URL. The picker uses these as the fallback when the
     *  visible viewport intersects more shards than `maxHexShards`. Older
     *  manifests (pre-2026-04-30) only published `r6` here. */
    single_files?: string[]
    /** Per-shard bbox for cheap viewport-intersection (avoids
     *  client-side `cellToBoundary` on every pan). */
    shard_bboxes: Record<string, Bbox>
    row_counts?: Record<string, number>
    /** Legacy fields carried over from the v1 manifest — used by
     *  non-spatial UIs (year-range slider bounds, county/muni bbox
     *  fits, geocode-source breakdowns). */
    county_bboxes?: Record<number, Bbox>
    muni_bboxes?: Record<string, Bbox>
    by_geocode_src?: Record<string, number>
    per_year?: Record<string, number>
    per_year_county?: Record<string, number>
}

/** Shape consumed by the debug overlay: the cells-api plan adapted to
 *  the legacy planner's shape. `shards: null` = single-file. */
export type FetchPlan =
    { kind: "hex"; res: number; shards: string[] | null; reason?: string }

const MANIFEST_V2_URL = `${MAP_BASE_URL}/v2/manifest.v2.json`

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

/** Web-mercator meters-per-pixel; duplicated here to keep this module
 *  dependency-light. */
function metersPerPixel(zoom: number, lat: number): number {
    return 156543.03 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, zoom)
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
