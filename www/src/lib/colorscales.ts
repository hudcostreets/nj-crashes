// Colorscale definitions for dark-mode-adjusted plots.
// Uses pltly's ColorScale type and getColorAt interpolation.

import { type ColorScale, getColorAt as _getColorAt } from "pltly"

export type { ColorScale }
export const getColorAt = _getColorAt

// Dark-mode-adjusted scales: lighter start colors for visibility on dark backgrounds

export const INFERNO: ColorScale = [
    [0.0, '#d070d0'],
    [0.2, '#b84090'],
    [0.4, '#cc4778'],
    [0.6, '#ed6925'],
    [0.8, '#f9b621'],
    [1.0, '#fcffa4'],
]

export const VIRIDIS: ColorScale = [
    [0.0, '#7c71c0'],
    [0.25, '#5090c0'],
    [0.5, '#40b5a8'],
    [0.75, '#6dd070'],
    [1.0, '#c8e630'],
]

export const GRAYSCALE: ColorScale = [
    [0.0, '#808080'],
    [1.0, '#ffffff'],
]

export const BLUE_ORANGE: ColorScale = [
    [0.0, '#5a9bd4'],
    [0.25, '#8cc5e3'],
    [0.5, '#ffffbf'],
    [0.75, '#fdae61'],
    [1.0, '#f46d43'],
]

export const PLASMA: ColorScale = [
    [0.0, '#8b0aa5'],
    [0.25, '#b83289'],
    [0.5, '#db5c68'],
    [0.75, '#f89540'],
    [1.0, '#f0f921'],
]

export const COLORSCALES: Record<string, ColorScale> = {
    inferno: INFERNO,
    viridis: VIRIDIS,
    grayscale: GRAYSCALE,
    blueOrange: BLUE_ORANGE,
    plasma: PLASMA,
}

export type ColorScaleName = keyof typeof COLORSCALES
