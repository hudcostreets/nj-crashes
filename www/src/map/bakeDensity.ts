/** Heatmap render strategy C — bake KDE density surfaces to images, rendered as
 *  `BitmapLayer` textured quads (one per mercator tile, see `useHeatTiles`).
 *
 *  This is the CarbonPlan `zarr-layer` principle (decouple per-frame redraw
 *  from per-data-load work) with a CPU splat instead of a GPU render-to-texture
 *  pass: for each cell we add a Gaussian kernel, weighted by severity, into an
 *  accumulation grid; normalize; map through a 1-D colormap. The result is an
 *  image handed to `BitmapLayer` — so pan/zoom is a free textured-quad redraw
 *  (no re-aggregation).
 *
 *  The bake is split into two passes so the tiles can share one normalization:
 *    - `splatDensity` → a `DensityGrid` (raw Float32 accumulation + its bounds),
 *      over one tile's bounds.
 *    - `colorizeDensity` → the RGBA `ImageData`, given a shared `vmax` (a high
 *      quantile across the visible tiles), so adjacent tiles never show a
 *      brightness seam at a density gradient.
 *
 *  (Strategy A baked one such image over the whole fetched cell set; dropped, see
 *  `specs/map-mobile-perf.md` § Round 3.)
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
    /** Grid extent (a tile's bounds) and dims in pixels. */
    bounds: Bounds
    width: number
    height: number
}

export type ColorizeOpts = {
    colormap: ColormapName
    /** Density → colormap position uses `t = (v/vmax)^gamma` (γ<1 lifts the
     *  heavy tail off the ramp floor). */
    gamma: number
    /** Alpha ramps 0→1 as `t` goes 0→alphaKnee, so sparse areas fade out. */
    alphaKnee: number
    /** Normalization ceiling. Defaults to the grid's own `localMax`; C passes
     *  a shared value across tiles so brightness is consistent. */
    vmax?: number
    /** Colormap position for the faintest density (0 = the ramp's darkest end).
     *  Only the *color* is lifted — alpha still ramps from the raw `t` — so a
     *  single crash reads brighter without hard-edged halos. */
    floor?: number
}

/** Splat `cells` into a density grid over exactly `opts.bounds` (the caller
 *  includes margin cells whose kernel tails should bleed in). Returns null if
 *  there's nothing to splat. */
export function splatDensity(cells: StackedCell[], opts: SplatOpts): DensityGrid | null {
    if (!cells.length) return null

    const [west, south, east, north] = opts.bounds
    const { width, height } = opts

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

/** The `q`-quantile of the non-zero densities across `grids` — a robust shared
 *  `vmax`. Normalizing to the plain max lets one hotspot set the scale, so a
 *  tighter kernel (which concentrates that hotspot) dims everything else; a
 *  high quantile keeps contrast stable across σ, and values above it saturate.
 *  Strided-samples to ≤ `maxSamples` values, so it stays cheap on large tiles. */
export function densityQuantile(grids: Array<DensityGrid | null>, q: number, maxSamples = 200_000): number {
    let n = 0
    for (const g of grids) if (g) n += g.accum.length
    if (n === 0) return 0
    const stride = max(1, ceil(n / maxSamples))
    const vals: number[] = []
    for (const g of grids) {
        if (!g) continue
        const { accum } = g
        for (let i = 0; i < accum.length; i += stride) if (accum[i] > 0) vals.push(accum[i])
    }
    if (vals.length === 0) return 0
    vals.sort((a, b) => a - b)
    return vals[min(vals.length - 1, round(q * (vals.length - 1)))]
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
        const floor = opts.floor ?? 0
        for (let i = 0; i < accum.length; i++) {
            const t = min(1, pow(accum[i] * invVmax, gamma))
            if (t <= 0) continue
            const [r, g, b] = sampleColormap(opts.colormap, floor + (1 - floor) * t)
            const a = min(255, round(255 * min(1, t * invKnee)))
            const o = i * 4
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a
        }
    }
    return new ImageData(rgba, width, height)
}
