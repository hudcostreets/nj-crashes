/** County / muni boundary GeoJSON (`map/counties.geojson`, `map/munis/<cc>.geojson`); callers
 *  cache via react-query. */
import type { Feature, FeatureCollection } from "geojson"
import { Counties } from "@/src/njdot/data"
import { MAP_BASE_URL } from "./config"
import type { Bbox } from "./v2"

function fetchGeojson(url: string): Promise<FeatureCollection | null> {
    return fetch(url).then(r => (r.ok ? r.json() as Promise<FeatureCollection> : null))
}

export const fetchCounties = () => fetchGeojson(`${MAP_BASE_URL}/counties.geojson`)
export const fetchCounty = (cc: number) => fetchGeojson(`${MAP_BASE_URL}/counties/${String(cc).padStart(2, "0")}.geojson`)
/** One county's munis; features carry `{ cc, mc, name, label }`. */
export const fetchMunis = (cc: number) => fetchGeojson(`${MAP_BASE_URL}/munis/${String(cc).padStart(2, "0")}.geojson`)

/** `[w, s, e, n]` of a (Multi)Polygon feature. */
export function featureBbox(f: Feature): Bbox {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    const visit = (c: unknown): void => {
        if (!Array.isArray(c)) return
        if (typeof c[0] === "number") {
            const [x, y] = c as number[]
            if (x < w) w = x
            if (x > e) e = x
            if (y < s) s = y
            if (y > n) n = y
        } else c.forEach(visit)
    }
    const g = f.geometry
    if (g && "coordinates" in g) visit(g.coordinates)
    return [w, s, e, n]
}

export function bboxesIntersect([w, s, e, n]: Bbox, [w2, s2, e2, n2]: Bbox): boolean {
    return w <= e2 && w2 <= e && s <= n2 && s2 <= n
}

/** Area-hover fill fades from full (area covers ≤ `AREA_FILL_FULL_BELOW` of the view) to none
 *  (≥ `AREA_FILL_NONE_ABOVE`); see `areaFillScale`. */
export const AREA_FILL_FULL_BELOW = 0.25
export const AREA_FILL_NONE_ABOVE = 0.75
/** Samples per side of the grid `viewCoverage` tests against the polygon. */
export const COVER_GRID = 12

/** Fraction of `view` inside `f` (polygon, not bbox: a muni's bbox takes in rivers and neighbors),
 *  from a `COVER_GRID`² grid of cell-center samples. */
export function viewCoverage(f: Feature, view: Bbox, grid = COVER_GRID): number {
    const [w, s, e, n] = view
    if (e <= w || n <= s) return 0
    const bbox = cachedFeatureBbox(f)
    if (!bboxesIntersect(bbox, view)) return 0
    let hits = 0
    for (let i = 0; i < grid; i++) {
        const x = w + (e - w) * (i + 0.5) / grid
        for (let j = 0; j < grid; j++) {
            const y = s + (n - s) * (j + 0.5) / grid
            if (featureContains(f, [x, y])) hits++
        }
    }
    return hits / (grid * grid)
}

/** Multiplier on the hovered area's fill alpha. Zoomed in inside an area (at z14.5 all of Jersey
 *  City's part of the view is Jersey City) a full-strength fill tints the whole map and says
 *  nothing, so the fill fades out as the area covers more of the view; the outline always stays.
 *  (The hover drawer still names the area.) */
export function areaFillScale(coverage: number): number {
    const t = (AREA_FILL_NONE_ABOVE - coverage) / (AREA_FILL_NONE_ABOVE - AREA_FILL_FULL_BELOW)
    return Math.min(1, Math.max(0, t))
}

/** `featureBbox`, memoized per feature. */
export function cachedFeatureBbox(f: Feature): Bbox {
    let bbox = bboxCache.get(f)
    if (!bbox) { bbox = featureBbox(f); bboxCache.set(f, bbox) }
    return bbox
}

/** Hover-chip label for a drill-down polygon: a muni feature (`{ cc, mc, label }`, from
 *  `munis/<cc>.geojson`), with its county when `withCounty`, or a county feature (`{ name }`). */
export function outlineLabel(f: Feature, withCounty: boolean): string | null {
    const p = f.properties ?? {}
    if (p.mc !== undefined) {
        const muni: string = p.label ?? p.name
        const county = Counties[p.cc]
        return withCounty && county ? `${muni}, ${county} County` : muni
    }
    return p.name ? `${p.name} County` : null
}

/** Even-odd ray cast over every ring of a (Multi)Polygon, so holes (e.g. a doughnut-hole muni
 *  inside its surrounding township) are excluded. */
function inRings(rings: number[][][], x: number, y: number): boolean {
    let inside = false
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j]
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
        }
    }
    return inside
}

export function featureContains(f: Feature, [x, y]: [number, number]): boolean {
    const g = f.geometry
    if (g?.type === "Polygon") return inRings(g.coordinates, x, y)
    if (g?.type === "MultiPolygon") return g.coordinates.some(p => inRings(p, x, y))
    return false
}

/** The feature containing `lngLat` (first match, bbox-prefiltered), for hover/click hit-testing
 *  by cursor position rather than deck.gl picking, which only reports the topmost layer. */
const bboxCache = new WeakMap<Feature, Bbox>()

export function featureAt(features: Feature[], lngLat: [number, number]): Feature | null {
    const [x, y] = lngLat
    for (const f of features) {
        const [w, s, e, n] = cachedFeatureBbox(f)
        if (x >= w && x <= e && y >= s && y <= n && featureContains(f, lngLat)) return f
    }
    return null
}
