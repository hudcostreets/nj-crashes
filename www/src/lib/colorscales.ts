// Colorscale definitions and interpolation utilities

export type ColorStop = { pos: number; color: string }
export type ColorScale = {
    name: string
    stops: ColorStop[]
}

// Parse hex color to RGB
function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '')
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ]
}

// Convert RGB to hex
function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')
}

// Interpolate between two colors
function lerpColor(c1: string, c2: string, t: number): string {
    const [r1, g1, b1] = hexToRgb(c1)
    const [r2, g2, b2] = hexToRgb(c2)
    return rgbToHex(
        r1 + (r2 - r1) * t,
        g1 + (g2 - g1) * t,
        b1 + (b2 - b1) * t,
    )
}

// Get color at position t (0-1) from a colorscale
export function getColorAt(scale: ColorScale, t: number): string {
    t = Math.max(0, Math.min(1, t))
    const { stops } = scale

    // Find the two stops to interpolate between
    let i = 0
    while (i < stops.length - 1 && stops[i + 1].pos <= t) i++

    if (i >= stops.length - 1) return stops[stops.length - 1].color
    if (t <= stops[0].pos) return stops[0].color

    const s1 = stops[i]
    const s2 = stops[i + 1]
    const localT = (t - s1.pos) / (s2.pos - s1.pos)
    return lerpColor(s1.color, s2.color, localT)
}

// Generate n colors from a colorscale
export function getColors(scale: ColorScale, n: number, reverse = false): string[] {
    const colors: string[] = []
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1)
        colors.push(getColorAt(scale, t))
    }
    return reverse ? colors.reverse() : colors
}

// Inferno colorscale - adjusted for dark mode visibility
// All colors should be clearly visible against dark background
// Lightened start for better luminance balance across years
export const INFERNO: ColorScale = {
    name: 'Inferno',
    stops: [
        { pos: 0.0, color: '#d070d0' },  // Lighter magenta for better visibility
        { pos: 0.2, color: '#b84090' },
        { pos: 0.4, color: '#cc4778' },
        { pos: 0.6, color: '#ed6925' },
        { pos: 0.8, color: '#f9b621' },
        { pos: 1.0, color: '#fcffa4' },
    ],
}

// Viridis colorscale - adjusted for dark mode
export const VIRIDIS: ColorScale = {
    name: 'Viridis',
    stops: [
        { pos: 0.0, color: '#7c71c0' },  // Brighter purple start
        { pos: 0.25, color: '#5090c0' },
        { pos: 0.5, color: '#40b5a8' },
        { pos: 0.75, color: '#6dd070' },
        { pos: 1.0, color: '#c8e630' },
    ],
}

// Grayscale (visible grey to white)
export const GRAYSCALE: ColorScale = {
    name: 'Grayscale',
    stops: [
        { pos: 0.0, color: '#808080' },  // Mid grey start
        { pos: 1.0, color: '#ffffff' },
    ],
}

// Blue to Orange (both visible on dark)
export const BLUE_ORANGE: ColorScale = {
    name: 'Blue → Orange',
    stops: [
        { pos: 0.0, color: '#5a9bd4' },
        { pos: 0.25, color: '#8cc5e3' },
        { pos: 0.5, color: '#ffffbf' },
        { pos: 0.75, color: '#fdae61' },
        { pos: 1.0, color: '#f46d43' },
    ],
}

// Plasma colorscale - adjusted for visibility
export const PLASMA: ColorScale = {
    name: 'Plasma',
    stops: [
        { pos: 0.0, color: '#8b0aa5' },  // Brighter purple start
        { pos: 0.25, color: '#b83289' },
        { pos: 0.5, color: '#db5c68' },
        { pos: 0.75, color: '#f89540' },
        { pos: 1.0, color: '#f0f921' },
    ],
}

export const COLORSCALES: Record<string, ColorScale> = {
    inferno: INFERNO,
    viridis: VIRIDIS,
    grayscale: GRAYSCALE,
    blueOrange: BLUE_ORANGE,
    plasma: PLASMA,
}

export type ColorScaleName = keyof typeof COLORSCALES
