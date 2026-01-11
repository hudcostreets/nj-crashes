import React, { useMemo } from "react"
import { Layout, PlotData } from "plotly.js"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { NjspSource } from "@/src/icons"
import { usePlotState, getBaseLayout, fadeColor } from "./usePlotState"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "@/src/lib/colorscales"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
}

// Helper to decode y values (handles both array and binary-encoded formats)
function getYValues(trace: PlotData): number[] {
    const y = trace.y as unknown
    if (!y) return []
    if (Array.isArray(y)) {
        return (y as unknown[]).filter((v): v is number => typeof v === 'number')
    }
    // Handle Plotly's binary-encoded data format
    if (typeof y === 'object' && 'bdata' in y && 'dtype' in y) {
        const { bdata, dtype } = y as { bdata: string; dtype: string }
        const binary = atob(bdata)
        const values: number[] = []
        if (dtype === 'i2') {
            for (let i = 0; i < binary.length; i += 2) {
                const val = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8)
                values.push(val > 32767 ? val - 65536 : val)
            }
        }
        return values
    }
    return []
}

export function YtdDeathsPlot({ id = "ytd" }: Props) {
    const { params, activeTrace, plotColors, legendHandlers } = usePlotState("ytd-deaths.json")

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const [ytdOnly, setYtdOnly] = useSessionStorage<boolean>(`plot-${id}-ytd-only`, false)
    const colorScale = COLORSCALES[colorScaleName]

    // Process data with color adjustments
    const { data, layout } = useMemo(() => {
        if (!params) return { data: [], layout: {} as Partial<Layout> }

        // Sort traces chronologically ascending by year (for legend order)
        let sortedData = [...params.data].sort((a, b) => {
            const aName = String(a.name || '')
            const bName = String(b.name || '')
            if (/^20\d{2}$/.test(aName) && /^20\d{2}$/.test(bName)) {
                return parseInt(aName) - parseInt(bName)
            }
            return 0
        })

        const processedData = sortedData.map((trace, idx) => {
            const newTrace = { ...trace, legendrank: idx } as PlotData
            const name = String(trace.name || '')

            // Format year names as 'yy
            if (/^20\d{2}$/.test(name)) {
                newTrace.name = `'${name.slice(2)}`
            }

            // Apply colorscale to year traces
            const yearMatch = name.match(/^20\d{2}$/)
            if (yearMatch) {
                const year = parseInt(yearMatch[0])
                const minYear = 2008, maxYear = 2026
                const t = (year - minYear) / (maxYear - minYear)
                const color = getColorAt(colorScale, t)

                if (trace.type === 'scatter' || trace.type === 'scattergl') {
                    const displayName = `'${name.slice(2)}`
                    const isActive = activeTrace === name || activeTrace === displayName
                    const isGreyed = activeTrace !== null && !isActive
                    newTrace.line = {
                        ...trace.line,
                        color: isGreyed ? fadeColor(color) : color,
                        width: isActive ? 4 : (isGreyed ? 1 : 2),
                    }
                }
            }

            return newTrace
        })

        // Filter data to YTD range if enabled
        let filteredData = processedData
        if (ytdOnly) {
            const now = new Date()
            const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
            filteredData = processedData.map(trace => {
                const x = trace.x
                const y = trace.y
                if (!x || !y || !Array.isArray(x) || !Array.isArray(y)) return trace
                const filteredPts = (x as string[]).map((xVal, i) => ({ x: xVal, y: (y as number[])[i], idx: i }))
                    .filter(pt => pt.idx < dayOfYear)
                return {
                    ...trace,
                    x: filteredPts.map(pt => pt.x),
                    y: filteredPts.map(pt => pt.y),
                }
            })
        }

        // Destructure and exclude title, template from rest
        const { xaxis, yaxis, legend, title, template, ...rest } = params.layout

        // Format month-day ticktext as just month abbreviation
        const ticktext = xaxis?.ticktext as string[] | undefined
        const formattedTicktext = ticktext?.map(t => {
            const match = String(t).match(/^([A-Z][a-z]{2}) \d+$/)
            return match ? match[1] : String(t)
        })

        // Calculate y range for YTD mode - use RAW params.data to get max from ALL years
        let yRangeOverride: { range: [number, number] } | {} = {}
        if (ytdOnly) {
            const now = new Date()
            const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
            let maxY = 0
            // Use raw params.data (not filtered) to find max across ALL traces
            for (const trace of params.data as PlotData[]) {
                const yValues = getYValues(trace)
                for (let i = 0; i < Math.min(dayOfYear, yValues.length); i++) {
                    maxY = Math.max(maxY, yValues[i])
                }
            }
            // Add 10% padding, minimum of 10
            yRangeOverride = { range: [0, Math.max(10, Math.ceil(maxY * 1.1))] }
        }

        // Increase bottom margin when legend is at bottom
        const bottomMargin = legendPosition === 'bottom' ? 80 : 40

        const newLayout: Partial<Layout> = {
            ...rest,
            ...getBaseLayout(plotColors, HEIGHT),
            margin: { t: 0, b: bottomMargin, l: 35, r: 5 },
            xaxis: {
                ...xaxis,
                tickfont: { color: plotColors.textColor, size: 11 },
                gridcolor: plotColors.gridColor,
                tickangle: -45,
                automargin: true,
                ...(formattedTicktext ? { ticktext: formattedTicktext } : {}),
                ...(ytdOnly ? {
                    range: (() => {
                        const now = new Date()
                        const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
                        return [0, dayOfYear]
                    })(),
                } : {}),
            },
            yaxis: {
                ...yaxis,
                automargin: false,
                tickfont: { color: plotColors.textColor, size: 11 },
                gridcolor: plotColors.gridColor,
                autorange: !ytdOnly,
                fixedrange: true,
                ...yRangeOverride,
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
            datarevision: ytdOnly ? 'ytd' : 'full',
        }

        return { data: filteredData, layout: newLayout }
    }, [params, activeTrace, colorScale, plotColors, legendPosition, ytdOnly])

    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>YTD Deaths</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/ytd-deaths.png"
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3em', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={ytdOnly}
                        onChange={e => setYtdOnly(e.target.checked)}
                    />
                    YTD only
                </label>
            </div>
            <div className={css.plotNotes}>
                <p>Hover legend labels to preview; click to lock.</p>
                <NjspSource>
                    <p>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
                </NjspSource>
            </div>
        </div>
    )
}
