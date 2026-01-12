import React, { useCallback, useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@rdub/duckdb/duckdb"
import { useRegisteredDb } from "@/src/tableData"
import { YtdCsv } from "@/src/paths"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { NjspSource } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "@/src/lib/colorscales"
import { ControlsGear } from "@/src/components/ControlsGear"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
}

type YtdRow = {
    year: number
    day_of_year: number
    date_label: string
    fatalities: number
    cumulative: number
}

// Query to get YTD data
const ytdQuery = `
    SELECT year, day_of_year, date_label, fatalities, cumulative
    FROM read_csv_auto('ytd')
    ORDER BY year, day_of_year
`

// Helper to fade colors with configurable opacity
function fadeColor(color: string, opacity: number): string {
    if (color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        return `rgba(${r}, ${g}, ${b}, ${opacity})`
    }
    return color
}

// Check if a year is a leap year
function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

// Convert (year, day_of_year) to a reference date in year 2000 (leap year)
// This ensures consistent x-axis alignment: Feb 29 always exists, Mar 1 always at same position
function toRefDate(year: number, dayOfYear: number): string {
    let refDay = dayOfYear
    // Non-leap years: day 60 = Mar 1, but in ref year 2000, Mar 1 = day 61
    // So shift days >= 60 by +1 to align calendar dates
    if (!isLeapYear(year) && dayOfYear >= 60) {
        refDay = dayOfYear + 1
    }
    const date = new Date(2000, 0, refDay)  // Jan refDay, 2000
    return date.toISOString().split('T')[0]  // "2000-01-15"
}

// Convert day_of_year to reference date (for tick values, assume leap year)
function dayToRefDate(dayOfYear: number): string {
    const date = new Date(2000, 0, dayOfYear)
    return date.toISOString().split('T')[0]
}

export function YtdDeathsPlot({ id = "ytd" }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    // Legend interaction state
    const [soloYear, setSoloYear] = useState<number | null>(null)
    const [hoverYear, setHoverYear] = useState<number | null>(null)

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const [ytdOnly, setYtdOnly] = useSessionStorage<boolean>(`plot-${id}-ytd-only`, false)
    const [fadeOpacity, setFadeOpacity] = useSessionStorage<number>(`plot-${id}-fade-opacity`, 0.7)
    const [controlsOpen, setControlsOpen] = useSessionStorage<boolean>(`plot-${id}-controls-open`, false)
    const colorScale = COLORSCALES[colorScaleName]

    // Load YTD data
    const ytdDb = useRegisteredDb({ db, table: "ytd", url: YtdCsv })
    const ytdRows = useQuery<YtdRow>({ db: ytdDb, query: ytdQuery, init: [] })

    // Determine active year (hover takes precedence over solo)
    const activeYear = hoverYear ?? soloYear

    // Build plot data
    const { data, layout } = useMemo(() => {
        if (!ytdRows.length) {
            return { data: [], layout: {} as Partial<Layout> }
        }

        // Group data by year
        const yearData = new Map<number, YtdRow[]>()
        for (const row of ytdRows) {
            if (!yearData.has(row.year)) {
                yearData.set(row.year, [])
            }
            yearData.get(row.year)!.push(row)
        }

        // Sort years ascending
        const years = Array.from(yearData.keys()).sort((a, b) => a - b)
        const minYear = Math.min(...years)
        const maxYear = Math.max(...years) + 1  // Extend for projection

        // Current day of year for YTD filtering
        const now = new Date()
        const currentYear = now.getFullYear()
        const dayOfYear = Math.floor((now.getTime() - new Date(currentYear, 0, 0).getTime()) / (1000 * 60 * 60 * 24))
        // Reference date for current day (for x-axis range)
        const currentRefDate = toRefDate(currentYear, dayOfYear)

        // Build traces - use reference dates as x values for consistent alignment
        const traces: PlotData[] = years.map((year, idx) => {
            const rows = yearData.get(year)!
            const t = (year - minYear) / (maxYear - minYear)
            const color = getColorAt(colorScale, t)

            const isActive = activeYear === year
            const isGreyed = activeYear !== null && !isActive
            const isCurrentYear = year === currentYear

            // Forward-fill data so every day has a point (for correct hover)
            const maxDay = Math.max(...rows.map(r => r.day_of_year))
            const dayMap = new Map(rows.map(r => [r.day_of_year, r]))
            const filledRows: { day: number; cumulative: number; fatalities: number }[] = []
            let lastCumulative = 0
            for (let d = 1; d <= maxDay; d++) {
                const row = dayMap.get(d)
                if (row) {
                    lastCumulative = row.cumulative
                    filledRows.push({ day: d, cumulative: row.cumulative, fatalities: row.fatalities })
                } else {
                    filledRows.push({ day: d, cumulative: lastCumulative, fatalities: 0 })
                }
            }

            // Filter to YTD range if enabled
            let filteredRows = filledRows
            if (ytdOnly) {
                filteredRows = filledRows.filter(r => r.day <= dayOfYear)
            }

            // Current year gets thicker line by default
            const defaultWidth = isCurrentYear ? 4 : 2

            return {
                type: "scatter",
                mode: "lines",
                name: `'${String(year).slice(2)}`,
                x: filteredRows.map(r => toRefDate(year, r.day)),
                y: filteredRows.map(r => r.cumulative),
                // Pre-format the "+N" suffix so it's correct for each day
                customdata: filteredRows.map(r => r.fatalities > 0 ? ` +${r.fatalities}` : ''),
                line: {
                    color: isGreyed ? fadeColor(color, fadeOpacity) : color,
                    width: isActive ? 5 : (isGreyed ? 1 : defaultWidth),
                },
                legendrank: idx,
                hovertemplate: `%{y}%{customdata}<extra>'${String(year).slice(2)}</extra>`,
            } as PlotData
        })

        // Calculate y range for YTD mode
        let yRangeOverride: { range: [number, number] } | {} = {}
        if (ytdOnly) {
            let maxY = 0
            for (const [, rows] of yearData) {
                for (const row of rows) {
                    if (row.day_of_year <= dayOfYear) {
                        maxY = Math.max(maxY, row.cumulative)
                    }
                }
            }
            yRangeOverride = { range: [0, Math.max(10, Math.ceil(maxY * 1.1))] }
        }

        // Increase bottom margin when legend is at bottom
        const bottomMargin = legendPosition === 'bottom' ? 80 : 40

        // Find max day in data (from any year)
        let maxDayInData = 0
        for (const [, rows] of yearData) {
            for (const row of rows) {
                maxDayInData = Math.max(maxDayInData, row.day_of_year)
            }
        }

        // Choose tick granularity based on data range
        let tickDays: number[]

        if (ytdOnly) {
            // Choose tick interval based on how many days are shown
            let tickInterval: number
            if (dayOfYear <= 14) {
                tickInterval = 1  // Every day
            } else if (dayOfYear <= 31) {
                tickInterval = 2  // Every 2 days
            } else if (dayOfYear <= 60) {
                tickInterval = 5  // Every 5 days
            } else if (dayOfYear <= 120) {
                tickInterval = 7  // Weekly
            } else {
                tickInterval = 14  // Bi-weekly
            }

            // Generate tick positions at regular intervals
            tickDays = []
            for (let d = 1; d <= dayOfYear; d += tickInterval) {
                tickDays.push(d)
            }
        } else {
            // Full year: show monthly ticks (1st of each month in leap year 2000)
            // Jan 1=1, Feb 1=32, Mar 1=61, Apr 1=92, May 1=122, Jun 1=153,
            // Jul 1=183, Aug 1=214, Sep 1=245, Oct 1=275, Nov 1=306, Dec 1=336
            tickDays = [1, 32, 61, 92, 122, 153, 183, 214, 245, 275, 306, 336]
                .filter(d => d <= maxDayInData)
        }

        // Convert tick days to reference dates
        const tickvals = tickDays.map(d => dayToRefDate(d))

        // Month names for tick labels
        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

        // Format tick labels from reference dates
        const ticktext = tickDays.map(d => {
            const date = new Date(2000, 0, d)
            const month = MONTH_NAMES[date.getMonth()]
            const day = date.getDate()
            // In non-YTD mode (full year), just show month name
            // In YTD mode, show "Month Day" for non-1st days
            if (!ytdOnly || day === 1) return month
            return `${month} ${day}`
        })

        const layout: Partial<Layout> = {
            showlegend: true,
            height: HEIGHT,
            margin: { t: 0, b: bottomMargin, l: 35, r: 5 },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            hovermode: "x unified",
            hoverdistance: -1,  // Always snap to nearest point (no gaps)
            hoverlabel: {
                bgcolor: '#1a1a2e',
                bordercolor: plotColors.gridColor,
                font: { color: '#ffffff' },
            },
            xaxis: {
                tickfont: { color: plotColors.textColor, size: 13 },
                gridcolor: plotColors.gridColor,
                tickangle: -45,
                automargin: true,
                tickmode: 'array',
                tickvals: tickvals,
                ticktext: ticktext,
                fixedrange: true,
                hoverformat: '%b %e',  // "Mar  1" or "May 14" format for hover header
                ...(ytdOnly ? { range: ['1999-12-31', currentRefDate] } : {}),
            },
            yaxis: {
                automargin: false,
                tickfont: { color: plotColors.textColor, size: 11 },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                rangemode: ytdOnly ? undefined : "tozero",
                autorange: !ytdOnly,
                ...yRangeOverride,
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
    }, [ytdRows, activeYear, colorScale, plotColors, legendPosition, ytdOnly, fadeOpacity])

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
            <h2 id={id}><a href={`#${id}`}>YTD Deaths</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/ytd-deaths.png"
                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onLegendMouseOver={onLegendMouseOver}
                onLegendMouseOut={onLegendMouseOut}
            />
            <ControlsGear open={controlsOpen} onToggle={setControlsOpen}>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3em', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={ytdOnly}
                        onChange={e => setYtdOnly(e.target.checked)}
                    />
                    YTD only
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3em' }}>
                    <label>Opacity:</label>
                    <input
                        type="range"
                        min="0.1"
                        max="1"
                        step="0.1"
                        value={fadeOpacity}
                        onChange={e => setFadeOpacity(parseFloat(e.target.value))}
                        style={{ width: '60px', cursor: 'pointer' }}
                    />
                    <span style={{ minWidth: '2em' }}>{Math.round(fadeOpacity * 100)}%</span>
                </div>
            </ControlsGear>
            <div className={css.plotNotes}>
                <p>Hover legend labels to preview; click to lock.</p>
                <NjspSource>
                    <p>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
                </NjspSource>
            </div>
        </div>
    )
}
