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

/** `map/v2/manifest.v2.json` — non-spatial map metadata only.
 *
 *  Everything spatial comes from the cells-api worker now; this manifest
 *  lost its H3 fetch metadata (`shards`, `shard_bboxes`, `single_files`,
 *  per-artifact `row_counts`) in h3-removal Phase 3, along with the
 *  `points/` + `hex-r{N}` parquet tree they indexed. Schema 3 is what's
 *  left — and it's all the client ever read. */
export type MapManifestV2 = {
    schema_version: number
    /** Year-slider bounds. */
    year_range: [number, number]
    /** Fit-bounds when a route scopes the map to a county or municipality. */
    county_bboxes?: Record<number, Bbox>
    muni_bboxes?: Record<string, Bbox>
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
