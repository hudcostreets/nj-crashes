import { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useSoloTrace, fadeColor, useTheme } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { useApi, apiUrl } from "@/src/api"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { fold } from "fp-ts/Either"

type VictimSeverityRow = {
    y: number
    condition: number
    drivers: number
    passengers: number
    pedestrians: number
    cyclists: number
    num_crashes: number
}

// Victim types in the API response
const VICTIM_TYPES = [
    { key: 'drivers' as const, label: 'Driver', color: '#636EFA' },
    { key: 'passengers' as const, label: 'Passenger', color: '#00CC96' },
    { key: 'pedestrians' as const, label: 'Pedestrian', color: '#AB63FA' },
    { key: 'cyclists' as const, label: 'Cyclist', color: '#FFA15A' },
]

// Condition codes → labels (exclude 5=no injury for victim plot)
const CONDITIONS: { code: number, label: string }[] = [
    { code: 1, label: 'Fatal' },
    { code: 2, label: 'Serious Injury' },
    { code: 3, label: 'Minor Injury' },
    { code: 4, label: 'Possible Injury' },
]

const HEIGHT = 500

export function VictimSeverityPlot() {
    const { cc, mc } = useGeoFilter()
    const plotColors = usePlotColors()
    const { isDark } = useTheme()
    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    const url = useMemo(
        () => apiUrl("/njdot/victim-severity", { cc, mc }),
        [cc, mc],
    )
    const result = useApi<VictimSeverityRow>(url)

    const traceNames = useMemo(() => VICTIM_TYPES.map(vt => vt.label), [])
    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(traceNames, hoverTrace)

    const { traces, layout } = useMemo(() => {
        if (!result) return { traces: [], layout: {} }
        return fold(
            () => ({ traces: [] as Partial<PlotData>[], layout: {} as Partial<Layout> }),
            (rows: VictimSeverityRow[]) => {
                // Filter to conditions 1-4 (skip 5=no injury, no victims)
                const data = rows.filter(r => r.condition >= 1 && r.condition <= 4)

                const traces: Partial<PlotData>[] = []

                // Build one trace per victim type
                for (let vtIdx = 0; vtIdx < VICTIM_TYPES.length; vtIdx++) {
                    const vt = VICTIM_TYPES[vtIdx]
                    const xs: number[] = []
                    const ys: number[] = []
                    const sizes: number[] = []
                    const texts: string[] = []

                    for (const row of data) {
                        const count = row[vt.key]
                        if (count === 0) continue

                        xs.push(row.y)
                        // Jitter y position: spread 4 victim types within each condition band
                        // Condition 1 → y≈1, Condition 4 → y≈4
                        // Each victim type gets a small offset within the band
                        const yBase = row.condition
                        const jitter = (vtIdx - 1.5) * 0.2
                        ys.push(yBase + jitter)
                        sizes.push(count)
                        texts.push(`${vt.label}: ${count.toLocaleString()}<br>${CONDITIONS.find(c => c.code === row.condition)?.label}<br>${row.y}`)
                    }

                    const isActive = activeTrace === null || activeTrace === vt.label
                    const isGreyed = isActive && hoverTrace !== null && hoverTrace !== vt.label
                    const visible = isActive ? true : 'legendonly' as const
                    const displayColor = isGreyed ? fadeColor(vt.color) : vt.color

                    traces.push({
                        x: xs,
                        y: ys,
                        mode: 'markers',
                        type: 'scatter',
                        name: vt.label,
                        visible,
                        marker: {
                            size: sizes,
                            sizemode: 'area',
                            sizeref: 0, // computed below
                            sizemin: 3,
                            color: displayColor,
                            opacity: 0.7,
                            line: {
                                color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)',
                                width: 0.5,
                            },
                        },
                        text: texts,
                        hovertemplate: '%{text}<extra></extra>',
                    })
                }

                // Compute sizeref: normalize so the largest bubble is ~40px diameter
                const allSizes = traces.flatMap(t => (t.marker as any)?.size || []) as number[]
                const maxSize = Math.max(...allSizes, 1)
                const maxBubblePx = 22
                // sizeref = 2 * max_value / max_diameter^2
                const sizeref = 2 * maxSize / (maxBubblePx * maxBubblePx)
                for (const trace of traces) {
                    if (trace.marker && 'sizeref' in trace.marker) {
                        (trace.marker as any).sizeref = sizeref
                    }
                }

                const layout: Partial<Layout> = {
                    height: HEIGHT,
                    margin: { t: 30, b: 50, l: 110, r: 20 },
                    xaxis: {
                        title: undefined,
                        dtick: 2,
                        tickfont: { color: plotColors.textColor },
                        gridcolor: plotColors.gridColor,
                        fixedrange: true,
                    },
                    yaxis: {
                        tickvals: CONDITIONS.map(c => c.code),
                        ticktext: CONDITIONS.map(c => c.label),
                        tickfont: { color: plotColors.textColor },
                        gridcolor: plotColors.gridColor,
                        fixedrange: true,
                        autorange: 'reversed' as const,
                        range: [0.2, 4.8],
                    },
                    showlegend: true,
                    legend: {
                        orientation: 'h' as const,
                        y: -0.12,
                        x: 0.5,
                        xanchor: 'center' as const,
                        yanchor: 'top' as const,
                        font: { color: plotColors.textColor },
                    },
                    hovermode: 'closest',
                    hoverlabel: {
                        bgcolor: plotColors.legendBg,
                        bordercolor: plotColors.gridColor,
                        font: { color: plotColors.textColor },
                    },
                    paper_bgcolor: plotColors.paperBg,
                    plot_bgcolor: plotColors.plotBg,
                    dragmode: false,
                }

                return { traces, layout }
            },
        )(result)
    }, [result, activeTrace, hoverTrace, plotColors, isDark])

    if (!result) {
        return <div style={{ height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Loading victim data...
        </div>
    }

    return fold(
        (err: Error) => (
            <div style={{ height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'red' }}>
                Error: {err.message}
            </div>
        ),
        () => (
            <PlotWrapper
                data={traces as PlotData[]}
                layout={layout}
                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onHoverTrace={setHoverTrace}
                onResetSolo={resetSolo}
            />
        ),
    )(result)
}
