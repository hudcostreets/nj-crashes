import React, { useMemo } from "react"
import { Layout, PlotData } from "plotly.js"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { NjspSource } from "@/src/icons"
import { usePlotState, getBaseLayout, fadeColor } from "./usePlotState"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "@/src/lib/colorscales"
import css from "./plot.module.scss"

const HEIGHT = 550

export type Props = {
    id?: string
}

export function FatalitiesByMonthBarsPlot({ id = "by-month-bars" }: Props) {
    const { params, activeTrace, plotColors, legendHandlers } = usePlotState("fatalities_by_month_bars.json")

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const colorScale = COLORSCALES[colorScaleName]

    // Process data with color adjustments
    const { data, layout } = useMemo(() => {
        if (!params) return { data: [], layout: {} as Partial<Layout> }

        // Sort traces chronologically ascending by year (for legend order)
        const sortedData = [...params.data].sort((a, b) => {
            const aName = String(a.name || '')
            const bName = String(b.name || '')
            if (/^20\d{2}$/.test(aName) && /^20\d{2}$/.test(bName)) {
                return parseInt(aName) - parseInt(bName)
            }
            return 0
        })

        const processedData: PlotData[] = []
        let activeTraceXs: (string | number)[] = []
        let activeTraceYs: number[] = []
        let activeTraceColor: string = ''
        let hasActiveTrace = false

        sortedData.forEach((trace, idx) => {
            const newTrace = { ...trace, legendrank: idx } as PlotData
            const originalName = String(trace.name || '')

            // Format year names as 'yy
            const displayName = /^20\d{2}$/.test(originalName) ? `'${originalName.slice(2)}` : originalName
            newTrace.name = displayName

            const matchesActive = activeTrace !== null && (originalName === activeTrace || displayName === activeTrace)
            const isGreyed = activeTrace !== null && !matchesActive

            // Apply colorscale to year traces
            const yearMatch = originalName.match(/^20\d{2}$/)
            if (yearMatch && trace.type === 'bar') {
                const year = parseInt(yearMatch[0])
                const minYear = 2008, maxYear = 2026
                const t = (year - minYear) / (maxYear - minYear)
                const color = getColorAt(colorScale, t)

                newTrace.marker = {
                    ...trace.marker,
                    color: isGreyed ? fadeColor(color) : color,
                    line: { color: 'transparent', width: 0 },
                }

                // Track active trace for annotations
                if (matchesActive) {
                    activeTraceXs = trace.x as (string | number)[]
                    activeTraceYs = trace.y as number[]
                    activeTraceColor = color
                    hasActiveTrace = true
                    // Make selected trace wider and on top
                    ;(newTrace as any).width = 0.25
                    ;(newTrace as any).zorder = 100
                } else if (activeTrace !== null) {
                    ;(newTrace as any).zorder = 1
                }
            }

            processedData.push(newTrace)
        })

        // Build annotations for active trace
        const annotations: Partial<Layout>['annotations'] = []
        if (hasActiveTrace) {
            const numTraces = params.data.filter(t => /^20\d{2}$/.test(String(t.name))).length
            const barWidth = 0.8 / numTraces
            const traceIdx = params.data.findIndex(t => {
                const name = String(t.name || '')
                return name === activeTrace || `'${name.slice(2)}` === activeTrace
            })
            const barCenter = -0.4 + barWidth * (traceIdx + 0.5)

            activeTraceXs.forEach((x, i) => {
                const y = activeTraceYs[i]
                if (y === undefined || y === null) return
                annotations.push({
                    x: typeof x === 'number' ? x + barCenter : x,
                    y: y,
                    text: `<b>${Math.round(y)}</b>`,
                    showarrow: false,
                    yshift: 18,
                    font: { color: activeTraceColor, size: 14 },
                    bgcolor: 'rgba(0, 0, 0, 0.6)',
                    borderpad: 2,
                })
            })
        }

        // Exclude title, template from rest
        const { xaxis, yaxis, legend, title, template, ...rest } = params.layout

        // Increase bottom margin when legend is at bottom
        const bottomMargin = legendPosition === 'bottom' ? 80 : 40

        const newLayout: Partial<Layout> = {
            ...rest,
            ...getBaseLayout(plotColors, HEIGHT),
            margin: { t: 0, b: bottomMargin, l: 0, r: 0 },
            xaxis: {
                ...xaxis,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                automargin: true,
                tickangle: -45,
            },
            yaxis: {
                ...yaxis,
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
            },
            legend: {
                ...legend,
                font: { color: plotColors.textColor },
                traceorder: 'normal',
                ...(legendPosition === 'right' ? {
                    orientation: 'v',
                    x: 1.02,
                    xanchor: 'left',
                    y: 1,
                    yanchor: 'top',
                } : {
                    orientation: 'h',
                    x: 0.5,
                    xanchor: 'center',
                    y: -0.08,
                    yanchor: 'top',
                }),
            },
            annotations,
        }

        return { data: processedData, layout: newLayout }
    }, [params, activeTrace, colorScale, plotColors, legendPosition])

    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Fatalities by Month</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/fatalities_by_month_bars.png"
                {...legendHandlers}
            />
            <div style={{ marginTop: '0.5em', fontSize: '12px', display: 'flex', gap: '1em', flexWrap: 'wrap' }}>
                <div>
                    <label style={{ marginRight: '0.5em' }}>Colors:</label>
                    <select
                        value={colorScaleName}
                        onChange={e => setColorScaleName(e.target.value as ColorScaleName)}
                        style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-primary)',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '12px',
                        }}
                    >
                        <option value="inferno">Inferno</option>
                        <option value="viridis">Viridis</option>
                        <option value="plasma">Plasma</option>
                        <option value="grayscale">Grayscale</option>
                        <option value="blueOrange">Blue → Orange</option>
                    </select>
                </div>
                <div>
                    <label style={{ marginRight: '0.5em' }}>Legend:</label>
                    <select
                        value={legendPosition}
                        onChange={e => setLegendPosition(e.target.value as 'bottom' | 'right')}
                        style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-primary)',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontSize: '12px',
                        }}
                    >
                        <option value="bottom">Bottom</option>
                        <option value="right">Right</option>
                    </select>
                </div>
            </div>
            <div className={css.plotNotes}>
                <p>Hover legend labels to preview; click to lock.</p>
                <NjspSource />
            </div>
        </div>
    )
}
