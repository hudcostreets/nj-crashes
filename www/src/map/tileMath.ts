/** Web-mercator (slippy-map) tile helpers for heatmap strategy C.
 *
 *  C renders the density surface as a pyramid of mercator tiles, each baked at
 *  its own zoom so the raster is always ~screen-resolution (fixing A's blur when
 *  zoomed into a coarse bake). These are the standard XYZ tile ↔ lng/lat
 *  conversions plus a viewport→visible-tiles helper.
 */
import type { Bounds } from "./bakeDensity"

const { floor, atan, sinh, tan, log, PI, max, min, pow } = Math

export type Tile = { z: number; x: number; y: number }

const asinh = (x: number) => log(x + Math.sqrt(x * x + 1))

export function lngToTileX(lng: number, z: number): number {
    return ((lng + 180) / 360) * pow(2, z)
}

export function latToTileY(lat: number, z: number): number {
    const r = (lat * PI) / 180
    return ((1 - asinh(tan(r)) / PI) / 2) * pow(2, z)
}

/** [west, south, east, north] in degrees for tile (z,x,y). */
export function tileToBounds(z: number, x: number, y: number): Bounds {
    const n = pow(2, z)
    const west = (x / n) * 360 - 180
    const east = ((x + 1) / n) * 360 - 180
    const north = (atan(sinh(PI * (1 - (2 * y) / n))) * 180) / PI
    const south = (atan(sinh(PI * (1 - (2 * (y + 1)) / n))) * 180) / PI
    return [west, south, east, north]
}

/** Expand a bounds by `frac` of its own span on every side (the margin whose
 *  cells' kernel tails bleed into the tile so per-tile bakes don't seam). */
export function padBounds([w, s, e, n]: Bounds, frac: number): Bounds {
    const dw = (e - w) * frac
    const dh = (n - s) * frac
    return [w - dw, s - dh, e + dw, n + dh]
}

/** Tiles at level `z` covering the lng/lat `bounds`, clamped to valid range. */
export function tilesForBounds(bounds: Bounds, z: number): Tile[] {
    const n = pow(2, z)
    const [w, s, e, north] = bounds
    const x0 = max(0, floor(lngToTileX(w, z)))
    const x1 = min(n - 1, floor(lngToTileX(e, z)))
    // North latitude → smaller y.
    const y0 = max(0, floor(latToTileY(north, z)))
    const y1 = min(n - 1, floor(latToTileY(s, z)))
    const out: Tile[] = []
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) out.push({ z, x, y })
    }
    return out
}

export const tileKey = (t: Tile): string => `${t.z}/${t.x}/${t.y}`
