/** Heatmap render strategies A and C — bake a KDE density surface to an image,
 *  then render it as a `BitmapLayer` textured quad.
 *
 *  This is the CarbonPlan `zarr-layer` principle (decouple per-frame redraw
 *  from per-data-load work) with a CPU splat instead of a GPU render-to-texture
 *  pass: for each cell we add a Gaussian kernel, weighted by severity, into an
 *  accumulation grid; normalize; map through a 1-D colormap. The result is an
 *  image handed to `BitmapLayer` — so pan/zoom is a free textured-quad redraw
 *  (no re-aggregation), where legacy's `HeatmapLayer` re-runs its KDE per frame.
 *
 *  The bake is split into two passes so C (tiled) can share one normalization
 *  across many tiles:
 *    - `splatDensity` → a `DensityGrid` (raw Float32 accumulation + its bounds).
 *    - `colorizeDensity` → the RGBA `ImageData`, given a `vmax`.
 *  A (`bakeDensity`) runs both over the data's auto-bounds, self-normalized. C
 *  splats each tile over its own tile bounds, takes the max `localMax` across
 *  the visible tiles as a shared `vmax`, then colorizes each — so adjacent tiles
 *  never show a brightness seam at a density gradient.
 *
 *  vs strategy B (`SoftDiscLayer`): B splats one GPU disc per cell every frame
 *  (cheap, but the cell grid is faintly visible); A/C bake a true continuous KDE
 *  so the surface is silky. A's single image is fixed-resolution (blurs when
 *  zoomed far past the bake density) — which is exactly what C's per-tile bake
 *  at the current scale fixes.
 */
import { sampleColormap, type ColormapName } from "./colormap"
import type { StackedCell } from "./StackedCellLayer"

const { exp, pow, ceil, min, max, round, cos, PI } = Math

const METERS_PER_DEG_LAT = 111_320

export type Bounds = [number, number, number, number]

/** Raw density accumulation grid, before colormapping. */
export type DensityGrid = {
    accum: Float32Array
    width: number
    height: number
    /** [west, south, east, north] in degrees — the grid's world extent. */
    bounds: Bounds
    /** Max accumulated value in this grid (for cross-grid shared normalization). */
    localMax: number
}

export type SplatOpts = {
    /** Kernel σ in meters (world-space); overlapping kernels sum into density. */
    sigmaMeters: number
    /** Per-cell weight (severity-weighted count). */
    weight: (c: StackedCell) => number
    /** Explicit grid extent + dims (C, tiled). When omitted, bounds are the
     *  cells' auto-extent padded by 3σ and the grid is sized to `maxDim` (A). */
    bounds?: Bounds
    width?: number
    height?: number
    /** Longest grid dimension in pixels when auto-sizing (A). */
    maxDim?: number
}

export type ColorizeOpts = {
    colormap: ColormapName
    /** Density → colormap position uses `t = (v/vmax)^gamma` (γ<1 lifts the
     *  heavy tail off the ramp floor). */
    gamma: number
    /** Alpha ramps 0→1 as `t` goes 0→alphaKnee, so sparse areas fade out. */
    alphaKnee: number
    /** Normalization ceiling. Defaults to the grid's own `localMax` (A); C
     *  passes the shared max across tiles so brightness is consistent. */
    vmax?: number
}

/** Splat `cells` into a density grid. With explicit `bounds`+`width`+`height`
 *  (C), splats over exactly that extent (the caller includes margin cells whose
 *  kernel tails should bleed in). Otherwise (A) computes a 3σ-padded auto-extent
 *  sized to `maxDim`. Returns null if there's nothing to splat. */
export function splatDensity(cells: StackedCell[], opts: SplatOpts): DensityGrid | null {
    if (!cells.length) return null

    let west: number, south: number, east: number, north: number
    let width: number, height: number

    if (opts.bounds && opts.width && opts.height) {
        [west, south, east, north] = opts.bounds
        width = opts.width
        height = opts.height
    } else {
        const maxDim = opts.maxDim ?? 1024
        west = Infinity; south = Infinity; east = -Infinity; north = -Infinity
        for (const c of cells) {
            const [lng, lat] = c.center
            if (lng < west) west = lng
            if (lng > east) east = lng
            if (lat < south) south = lat
            if (lat > north) north = lat
        }
        if (!(east > west) || !(north > south)) return null
        const midLat = (south + north) / 2
        const mPerDegLng = METERS_PER_DEG_LAT * cos((midLat * PI) / 180)
        const padLat = 3 * (opts.sigmaMeters / METERS_PER_DEG_LAT)
        const padLng = 3 * (opts.sigmaMeters / mPerDegLng)
        west -= padLng; east += padLng; south -= padLat; north += padLat
        const lngSpan = east - west, latSpan = north - south
        if (lngSpan >= latSpan) {
            width = maxDim
            height = max(1, round((latSpan / lngSpan) * maxDim))
        } else {
            height = maxDim
            width = max(1, round((lngSpan / latSpan) * maxDim))
        }
    }

    const lngSpan = east - west
    const latSpan = north - south
    if (!(lngSpan > 0) || !(latSpan > 0)) return null
    const midLat = (south + north) / 2
    const mPerDegLng = METERS_PER_DEG_LAT * cos((midLat * PI) / 180)
    const degPerPxX = lngSpan / width
    const degPerPxY = latSpan / height
    const sigmaPxX = (opts.sigmaMeters / mPerDegLng) / degPerPxX
    const sigmaPxY = (opts.sigmaMeters / METERS_PER_DEG_LAT) / degPerPxY
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
        const cx = round(cxf), cy = round(cyf)
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

    let localMax = 0
    for (let i = 0; i < accum.length; i++) if (accum[i] > localMax) localMax = accum[i]
    return { accum, width, height, bounds: [west, south, east, north], localMax }
}

/** Colormap a density grid into an RGBA image. `vmax` defaults to the grid's
 *  own `localMax`; pass a shared value for cross-tile consistency. */
export function colorizeDensity(grid: DensityGrid, opts: ColorizeOpts): ImageData {
    const vmax = opts.vmax ?? grid.localMax
    const { accum, width, height } = grid
    const rgba = new Uint8ClampedArray(width * height * 4)
    if (vmax > 0) {
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
    }
    return new ImageData(rgba, width, height)
}

export type BakedDensity = {
    /** RGBA image of the colormapped density surface. */
    image: ImageData
    /** [west, south, east, north] in degrees — the BitmapLayer quad bounds. */
    bounds: Bounds
    width: number
    height: number
}

export type BakeOpts = SplatOpts & ColorizeOpts

/** Strategy A: splat over the data's auto-extent, self-normalize, colorize. */
export function bakeDensity(cells: StackedCell[], opts: BakeOpts): BakedDensity | null {
    const grid = splatDensity(cells, opts)
    if (!grid || grid.localMax <= 0) return null
    return {
        image: colorizeDensity(grid, opts),
        bounds: grid.bounds,
        width: grid.width,
        height: grid.height,
    }
}
