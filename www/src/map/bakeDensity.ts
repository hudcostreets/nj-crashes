/** Heatmap render strategy A — bake a KDE density surface to an image once per
 *  data-load, then render it as a `BitmapLayer` textured quad.
 *
 *  This is the CarbonPlan `zarr-layer` principle (decouple per-frame redraw
 *  from per-data-load work) with a CPU splat instead of a GPU render-to-texture
 *  pass: for each cell we add a Gaussian kernel, weighted by severity, into an
 *  accumulation grid over the data's world bounds; normalize; map through a 1-D
 *  colormap. The result is a single image handed to `BitmapLayer` — so pan/zoom
 *  is a free textured-quad redraw (no re-aggregation), where legacy's
 *  `HeatmapLayer` re-runs its KDE every frame. Only a level/filter change (new
 *  cells) triggers a re-bake.
 *
 *  vs strategy B (`SoftDiscLayer`): B splats one GPU disc per cell every frame
 *  (cheap, but the cell grid is faintly visible and the kernel is per-cell); A
 *  bakes a true continuous KDE once, so the surface is silky and the grid never
 *  shows. Trade-off: A re-bakes (~tens of ms) on data-load and the baked image
 *  is fixed-resolution (softens if you zoom far past the bake density).
 */
import { sampleColormap, type ColormapName } from "./colormap"
import type { StackedCell } from "./StackedCellLayer"

const { exp, pow, ceil, min, max, round } = Math

export type BakedDensity = {
    /** RGBA image of the colormapped density surface. */
    image: ImageData
    /** [west, south, east, north] in degrees — the BitmapLayer quad bounds. */
    bounds: [number, number, number, number]
    /** Grid dims, for logging/perf. */
    width: number
    height: number
}

export type BakeOpts = {
    colormap: ColormapName
    /** Kernel σ in meters (world-space); overlapping kernels sum into density. */
    sigmaMeters: number
    /** Density → colormap position uses `t = (v/vmax)^gamma` (γ<1 lifts the
     *  heavy tail off the ramp floor). */
    gamma: number
    /** Alpha ramps 0→1 as `t` goes 0→alphaKnee, so sparse areas fade out. */
    alphaKnee: number
    /** Per-cell weight (severity-weighted count). */
    weight: (c: StackedCell) => number
    /** Longest grid dimension in pixels (the bake resolution). */
    maxDim?: number
}

const METERS_PER_DEG_LAT = 111_320

/** Bake `cells` into a colormapped KDE image. Returns null if there's nothing
 *  to draw (no cells, or a degenerate bounds). */
export function bakeDensity(cells: StackedCell[], opts: BakeOpts): BakedDensity | null {
    if (!cells.length) return null
    const maxDim = opts.maxDim ?? 1024

    // World bounds of the cell centers, padded by 3σ so kernels near the edge
    // aren't clipped.
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (const c of cells) {
        const [lng, lat] = c.center
        if (lng < west) west = lng
        if (lng > east) east = lng
        if (lat < south) south = lat
        if (lat > north) north = lat
    }
    if (!(east > west) || !(north > south)) return null

    const midLat = (south + north) / 2
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
    const sigmaDegLat = opts.sigmaMeters / METERS_PER_DEG_LAT
    const sigmaDegLng = opts.sigmaMeters / metersPerDegLng
    const padLat = 3 * sigmaDegLat
    const padLng = 3 * sigmaDegLng
    west -= padLng; east += padLng; south -= padLat; north += padLat

    const lngSpan = east - west
    const latSpan = north - south
    // Grid sized so the longer side is `maxDim`; pixels are ~square in degrees.
    let width: number, height: number
    if (lngSpan >= latSpan) {
        width = maxDim
        height = max(1, round((latSpan / lngSpan) * maxDim))
    } else {
        height = maxDim
        width = max(1, round((lngSpan / latSpan) * maxDim))
    }

    const degPerPxX = lngSpan / width
    const degPerPxY = latSpan / height
    const sigmaPxX = sigmaDegLng / degPerPxX
    const sigmaPxY = sigmaDegLat / degPerPxY
    // Isotropic kernel in pixels (grid pixels are ~square, so σx≈σy); use the
    // mean and a shared 1/(2σ²).
    const sigmaPx = (sigmaPxX + sigmaPxY) / 2
    const inv2s2 = 1 / (2 * sigmaPx * sigmaPx)
    const radius = max(1, ceil(3 * sigmaPx))

    const accum = new Float32Array(width * height)

    // Splat a Gaussian per cell. Image row 0 is north (top), so y grows south.
    for (const c of cells) {
        const w = opts.weight(c)
        if (w <= 0) continue
        const [lng, lat] = c.center
        const cxf = (lng - west) / degPerPxX
        const cyf = (north - lat) / degPerPxY
        const cx = round(cxf)
        const cy = round(cyf)
        const x0 = max(0, cx - radius), x1 = min(width - 1, cx + radius)
        const y0 = max(0, cy - radius), y1 = min(height - 1, cy + radius)
        for (let y = y0; y <= y1; y++) {
            const dy = y - cyf
            const rowBase = y * width
            for (let x = x0; x <= x1; x++) {
                const dx = x - cxf
                accum[rowBase + x] += w * exp(-(dx * dx + dy * dy) * inv2s2)
            }
        }
    }

    let vmax = 0
    for (let i = 0; i < accum.length; i++) if (accum[i] > vmax) vmax = accum[i]
    if (vmax <= 0) return null

    const rgba = new Uint8ClampedArray(width * height * 4)
    const invVmax = 1 / vmax
    const gamma = opts.gamma
    const invKnee = 1 / opts.alphaKnee
    for (let i = 0; i < accum.length; i++) {
        const t = pow(accum[i] * invVmax, gamma)
        if (t <= 0) continue
        const [r, g, b] = sampleColormap(opts.colormap, t)
        const a = min(255, round(255 * min(1, t * invKnee)))
        const o = i * 4
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a
    }

    return {
        image: new ImageData(rgba, width, height),
        bounds: [west, south, east, north],
        width,
        height,
    }
}
