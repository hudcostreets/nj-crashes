import React, { useCallback, useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@rdub/duckdb/duckdb"
import { useRegisteredDb } from "@/src/tableData"
import { MonthYearCsv } from "@/src/paths"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "@/src/lib/colorscales"
import { ControlsGear } from "@/src/components/ControlsGear"
import css from "./plot.module.scss"

const HEIGHT = 550

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type Props = {
    id?: string
}

type MonthYearRow = {
    year: number
    month: number
    fatalities: number
}

// Query to get month-year data
const monthYearQuery = `
    SELECT year, month, fatalities
    FROM read_csv_auto('month_year')
    ORDER BY year, month
`

// Helper to fade colors
function fadeColor(color: string): string {
    if (color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        return `rgba(${r}, ${g}, ${b}, 0.35)`
    }
    return color
}

export function FatalitiesByMonthBarsPlot({ id = "by-month-bars" }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    // Legend interaction state
    const [soloYear, setSoloYear] = useState<number | null>(null)
    const [hoverYear, setHoverYear] = useState<number | null>(null)

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const [controlsOpen, setControlsOpen] = useSessionStorage<boolean>(`plot-${id}-controls-open`, false)
    const colorScale = COLORSCALES[colorScaleName]

    // Load month-year data
    const monthYearDb = useRegisteredDb({ db, table: "month_year", url: MonthYearCsv })
    const monthYearRows = useQuery<MonthYearRow>({ db: monthYearDb, query: monthYearQuery, init: [] })

    // Determine active year (hover takes precedence over solo)
    const activeYear = hoverYear ?? soloYear

    // Build plot data
    const { data, layout } = useMemo(() => {
        if (!monthYearRows.length) {
            return { data: [], layout: {} as Partial<Layout> }
        }

        // Determine which months are complete (current month is incomplete)
        const now = new Date()
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1  // 1-indexed

        const isMonthComplete = (year: number, month: number) => {
            if (year < currentYear) return true
            if (year === currentYear && month < currentMonth) return true
            return false
        }

        // Group data by year, only including complete months
        const yearData = new Map<number, Map<number, number>>()
        for (const row of monthYearRows) {
            if (!isMonthComplete(row.year, row.month)) continue
            if (!yearData.has(row.year)) {
                yearData.set(row.year, new Map())
            }
            yearData.get(row.year)!.set(row.month, row.fatalities)
        }

        // Sort years ascending
        const years = Array.from(yearData.keys()).sort((a, b) => a - b)
        if (!years.length) {
            return { data: [], layout: {} as Partial<Layout> }
        }

        const minYear = Math.min(...years)
        const maxYear = Math.max(...years) + 1

        // Build traces (one bar trace per year)
        const traces: PlotData[] = years.map((year, idx) => {
            const monthData = yearData.get(year)!
            const t = (year - minYear) / (maxYear - minYear)
            const color = getColorAt(colorScale, t)

            const isActive = activeYear === year
            const isGreyed = activeYear !== null && !isActive

            // Get values for each month
            const values = MONTH_NAMES.map((_, i) => monthData.get(i + 1) ?? 0)

            const trace: any = {
                type: "bar",
                name: `'${String(year).slice(2)}`,
                x: MONTH_NAMES,
                y: values,
                marker: {
                    color: isGreyed ? fadeColor(color) : color,
                    line: { color: 'transparent', width: 0 },
                },
                legendrank: idx,
                hovertemplate: `%{y}<extra>'${String(year).slice(2)}</extra>`,
                // Show text labels on bars when this year is active
                text: isActive ? values.map(v => v > 0 ? `<b>${v}</b>` : '') : undefined,
                textposition: isActive ? 'outside' : undefined,
                textfont: isActive ? { color: '#ffffff', size: 14 } : undefined,
                // Add vertical offset for text above bars
                textangle: 0,
                constraintext: 'none',
                cliponaxis: false,
            }

            // Make selected trace wider and on top
            if (isActive) {
                trace.width = 0.25
                trace.zorder = 100
            } else if (activeYear !== null) {
                trace.zorder = 1
            }

            return trace as PlotData
        })

        // Increase bottom margin when legend is at bottom
        const bottomMargin = legendPosition === 'bottom' ? 80 : 40

        const layout: Partial<Layout> = {
            barmode: "group",
            showlegend: true,
            height: HEIGHT,
            margin: { t: 0, b: bottomMargin, l: 0, r: 0 },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            hovermode: "x unified",
            hoverlabel: {
                bgcolor: '#1a1a2e',
                bordercolor: plotColors.gridColor,
                font: { color: '#ffffff' },
            },
            xaxis: {
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                automargin: true,
                tickangle: -45,
                fixedrange: true,
            },
            yaxis: {
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                rangemode: "tozero",
            },
            legend: {
                font: { color: plotColors.textColor },
                traceorder: 'normal',
                ...(legendPosition === 'right' ? {
                    orientation: 'v' as const,
                    x: 1.02,
                    xanchor: 'left' as const,
                    y: 1,
                    yanchor: 'top' as const,
                } : {
                    orientation: 'h' as const,
                    x: 0.5,
                    xanchor: 'center' as const,
                    y: -0.08,
                    yanchor: 'top' as const,
                }),
            },
            dragmode: false,
        }

        return { data: traces, layout }
    }, [monthYearRows, activeYear, colorScale, plotColors, legendPosition])

    // Legend click handler
    const onLegendClick = useCallback((name: string) => {
        const yearMatch = name.match(/'(\d{2})/)
        if (!yearMatch) return false
        const year = 2000 + parseInt(yearMatch[1])
        if (soloYear === year) {
            setSoloYear(null)
            setHoverYear(null)
        } else {
            setSoloYear(year)
        }
        return false
    }, [soloYear])

    // Legend double-click handler
    const onLegendDoubleClick = useCallback(() => {
        setSoloYear(null)
        setHoverYear(null)
        return false
    }, [])

    // Legend hover handlers
    const onLegendMouseOver = useCallback((name: string) => {
        const yearMatch = name.match(/'(\d{2})/)
        if (yearMatch) {
            setHoverYear(2000 + parseInt(yearMatch[1]))
        }
        return true
    }, [])

    const onLegendMouseOut = useCallback(() => {
        setHoverYear(null)
        return true
    }, [])

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
                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onLegendMouseOver={onLegendMouseOver}
                onLegendMouseOut={onLegendMouseOut}
            />
            <ControlsGear
                open={controlsOpen}
                onToggle={setControlsOpen}
                extra={<PlotInfo source="njsp" />}
                bottomLegend={legendPosition === 'bottom'}
            >
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
                        <option value="blueOrange">Blue -&gt; Orange</option>
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
            </ControlsGear>
        </div>
    )
}
