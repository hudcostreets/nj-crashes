import type { Layout } from "plotly.js"
import type { Annotation } from "./types"

type LayoutShape = NonNullable<Layout['shapes']>[number]
type LayoutAnnotation = NonNullable<Layout['annotations']>[number]

const SEVERITY_COLORS: Record<Annotation['severity'], { fill: string; border: string; icon: string }> = {
    warning: { fill: 'rgba(216, 96, 96, 0.13)', border: 'rgba(216, 96, 96, 0.4)', icon: '#f0a0a0' },
    caveat: { fill: 'rgba(216, 176, 96, 0.13)', border: 'rgba(216, 176, 96, 0.4)', icon: '#e8c880' },
    info: { fill: 'rgba(96, 144, 216, 0.13)', border: 'rgba(96, 144, 216, 0.4)', icon: '#a0c0f0' },
}

const ICON: Record<Annotation['severity'], string> = {
    warning: '⚠',
    caveat: '⚑',
    info: 'ⓘ',
}

/**
 * Returns Plotly layout pieces for year-ranged annotations:
 *   - `shapes`: full-plot-height tint behind the affected x-range
 *   - `annotations`: a small ⚠ icon pinned in the upper-right of each rect
 *
 * The annotation body text lives in a `<details>`-style panel below the
 * plot (see `AnnotationDetails`); the plot itself only needs the shade +
 * icon as a visual cue. This keeps Plotly's x-unified hoverbox
 * at its normal, fit-to-text size.
 */
export function toPlotLayers(annotations: Annotation[]): {
    shapes: LayoutShape[]
    annotations: LayoutAnnotation[]
} {
    const shapes: LayoutShape[] = []
    const plotAnns: LayoutAnnotation[] = []
    for (const a of annotations) {
        const yr = a.applies_to.year_range
        if (!yr) continue
        const [y0, y1] = yr
        const col = SEVERITY_COLORS[a.severity]
        shapes.push({
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0: y0 - 0.5,
            x1: y1 + 0.5,
            y0: 0,
            y1: 1,
            fillcolor: col.fill,
            line: { color: col.border, width: 0 },
            layer: 'below',
        })
        // Small icon pinned inside the upper-right of the shaded rect.
        plotAnns.push({
            xref: 'x',
            yref: 'paper',
            x: y1 + 0.35,
            y: 0.97,
            xanchor: 'right',
            yanchor: 'top',
            text: ICON[a.severity],
            font: { size: 14, color: col.icon },
            showarrow: false,
        })
    }
    return { shapes, annotations: plotAnns }
}

/** True if `year` falls inside any annotation's `year_range`. */
export function yearInAnyRange(annotations: Annotation[], year: number): boolean {
    for (const a of annotations) {
        const yr = a.applies_to.year_range
        if (!yr) continue
        if (year >= yr[0] && year <= yr[1]) return true
    }
    return false
}
