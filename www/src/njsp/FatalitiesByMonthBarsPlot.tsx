import React, { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { MonthYearCsv } from "@/src/paths"
import { fadeColor, useSoloTrace } from "pltly"
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
    county?: string | null
    cc?: number | null
    mc?: number | null
    regionLabel?: string | null
}

type MonthYearRow = {
    year: number
    month: number
    fatalities: number
}

// Query to get month-year data (filtered by geo level)
const monthYearQueryFn = (county: string | null, cc: number | null, mc: number | null) => {
    let where: string
    if (cc !== null && mc !== null) {
        where = `cc = ${cc} AND mc = ${mc}`
    } else if (county) {
        where = `county = '${county}' AND mc IS NULL`
    } else {
        where = `county IS NULL AND cc IS NULL`
    }
    return `
    SELECT year, month, fatalities
    FROM read_csv_auto('month_year')
    WHERE ${where}
    ORDER BY year, month
`
}

export function FatalitiesByMonthBarsPlot({ id = "by-month-bars", county, cc = null, mc = null, regionLabel }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const [controlsOpen, setControlsOpen] = useSessionStorage<boolean>(`plot-${id}-controls-open`, false)
    const colorScale = COLORSCALES[colorScaleName]

    // Load month-year data
    const monthYearDb = useRegisteredDb({ db, table: "month_year", url: MonthYearCsv })
    const monthYearQueryStr = useMemo(() => monthYearQueryFn(county ?? null, cc ?? null, mc ?? null), [county, cc, mc])
    const monthYearRows = useQuery<MonthYearRow>({ db: monthYearDb, query: monthYearQueryStr, init: [] })

    // Compute trace names from data for solo hook
    const traceNames = useMemo(() => {
        const years = [...new Set(monthYearRows.map(r => r.year))].sort((a, b) => a - b)
        return years.map(y => `'${String(y).slice(2)}`)
    }, [monthYearRows])

    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(traceNames, hoverTrace)

    // Derive year from string trace name
    const activeYear = useMemo(() => {
        if (!activeTrace) return null
        const match = activeTrace.match(/'(\d{2})/)
        return match ? 2000 + parseInt(match[1]) : null
    }, [activeTrace])

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


    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Fatalities by Month</a></h2>
            <div className={css.subtitle}>Fatal crashes, 2008–present{regionLabel ? ` · ${regionLabel}` : county ? ` · ${county} County` : ''}</div>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}

                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onHoverTrace={setHoverTrace}
                onResetSolo={resetSolo}
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
