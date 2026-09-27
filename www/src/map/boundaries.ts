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
        let bbox = bboxCache.get(f)
        if (!bbox) { bbox = featureBbox(f); bboxCache.set(f, bbox) }
        const [w, s, e, n] = bbox
        if (x >= w && x <= e && y >= s && y <= n && featureContains(f, lngLat)) return f
    }
    return null
}
