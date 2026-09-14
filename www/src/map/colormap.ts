/** 1-D sequential colormaps for the density-render strategies.
 *
 * Stored as a small list of evenly-spaced RGB control points; `sample(t)`
 * linearly interpolates for t∈[0,1]. The B baseline samples this CPU-side
 * (once per data-load, in the layer-build memo — no per-frame cost); A/C will
 * upload the same stops as a 1-D texture and sample it on the GPU so ramp/clim
 * changes are uniform-only. Keeping one source of truth here means the CPU and
 * GPU paths render identical colors.
 */

export type Rgb = [number, number, number]

/** Perceptually-uniform "heat" ramp (magma/inferno family): dark purple →
 *  magenta → orange → pale yellow. Reads as density/intensity better than the
 *  categorical F/I/O severity palette (severity is carried by the weighting of
 *  the input, not the ramp). */
const INFERNO: Rgb[] = [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
]

const VIRIDIS: Rgb[] = [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [181, 222, 43],
    [253, 231, 37],
]

export const COLORMAPS = { inferno: INFERNO, viridis: VIRIDIS } as const
export type ColormapName = keyof typeof COLORMAPS

/** Sample a colormap at t∈[0,1] (clamped), linearly interpolating between the
 *  two nearest control points. Returns integer RGB in [0,255]. */
export function sampleColormap(name: ColormapName, t: number): Rgb {
    const stops = COLORMAPS[name]
    const x = t <= 0 ? 0 : t >= 1 ? 1 : t
    const pos = x * (stops.length - 1)
    const i = Math.floor(pos)
    const f = pos - i
    if (i >= stops.length - 1) return stops[stops.length - 1]
    const a = stops[i]
    const b = stops[i + 1]
    return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    ]
}
