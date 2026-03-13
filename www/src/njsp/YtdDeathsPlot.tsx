import React, { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { YtdCsv } from "@/src/paths"
import { fadeColor, useSoloTrace, useCustomHover } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "@/src/lib/colorscales"
import { ControlsGear } from "@/src/components/ControlsGear"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
    county?: string | null
    cc?: number | null
    mc?: number | null
    regionLabel?: string | null
}

type YtdRow = {
    year: number
    day_of_year: number
    date_label: string
    fatalities: number
    cumulative: number
}

// Query to get YTD data (filtered by geo level)
const ytdQueryFn = (county: string | null, cc: number | null, mc: number | null) => {
    let where: string
    if (cc !== null && mc !== null) {
        where = `cc = ${cc} AND mc = ${mc}`
    } else if (county) {
        where = `county = '${county}' AND mc IS NULL`
    } else {
        where = `county IS NULL AND cc IS NULL`
    }
    return `
    SELECT year, day_of_year, date_label, fatalities, cumulative
    FROM read_csv_auto('ytd')
    WHERE ${where}
    ORDER BY year, day_of_year
`
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

type ViewMode = 'ytd' | 'full-faded' | 'full'

export function YtdDeathsPlot({ id = "ytd", county, cc = null, mc = null, regionLabel }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    // Per-plot settings (scoped by plot ID in session storage)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, 'right')
    const [viewMode, setViewMode] = useSessionStorage<ViewMode>(`plot-${id}-view-mode`, 'full-faded')
    const [controlsOpen, setControlsOpen] = useSessionStorage<boolean>(`plot-${id}-controls-open`, false)
    const [fadeOpacity, setFadeOpacity] = useSessionStorage<number>(`plot-${id}-fade-opacity`, 0.5)
    const [greyOpacity, setGreyOpacity] = useSessionStorage<number>(`plot-${id}-grey-opacity`, 0.2)
    const [futureDash, setFutureDash] = useSessionStorage<string>(`plot-${id}-future-dash`, 'dot')
    // Effective opacity: Full mode forces 1.0, Faded uses stored value
    const effectiveFadeOpacity = viewMode === 'full' ? 1.0 : fadeOpacity
    const colorScale = COLORSCALES[colorScaleName]

    // Load YTD data
    const ytdDb = useRegisteredDb({ db, table: "ytd", url: YtdCsv })
    const ytdQueryStr = useMemo(() => ytdQueryFn(county ?? null, cc ?? null, mc ?? null), [county, cc, mc])
    const ytdRows = useQuery<YtdRow>({ db: ytdDb, query: ytdQueryStr, init: [] })

    // Compute trace names from data for solo hook
    const traceNames = useMemo(() => {
        const years = [...new Set(ytdRows.map(r => r.year))].sort((a, b) => a - b)
        return years.map(y => `'${String(y).slice(2)}`)
    }, [ytdRows])

    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(traceNames, hoverTrace)

    // Derive year from string trace name
    const activeYear = useMemo(() => {
        if (!activeTrace) return null
        const match = activeTrace.match(/'(\d{2})/)
        return match ? 2000 + parseInt(match[1]) : null
    }, [activeTrace])

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

        // Ensure current year always has a trace (even with 0 deaths)
        const currentYearNow = new Date().getFullYear()
        if (!yearData.has(currentYearNow)) {
            yearData.set(currentYearNow, [{ year: currentYearNow, day_of_year: 1, date_label: 'Jan 01', fatalities: 0, cumulative: 0 }])
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

        const isYtd = viewMode === 'ytd'
        const isFaded = viewMode === 'full-faded' || viewMode === 'full'

        // Build traces - use reference dates as x values for consistent alignment
        const traces: PlotData[] = []
        for (let idx = 0; idx < years.length; idx++) {
            const year = years[idx]
            const rows = yearData.get(year)!
            const t = (year - minYear) / (maxYear - minYear)
            const color = getColorAt(colorScale, t)

            const isActive = activeYear === year
            const isGreyed = activeYear !== null && !isActive
            const isCurrentYear = year === currentYear

            // Forward-fill data so every day has a point (for correct hover)
            // For current year: extend to today; for past years: extend to end of their data
            const dataMaxDay = Math.max(...rows.map(r => r.day_of_year))
            const fillToDay = isCurrentYear ? Math.max(dataMaxDay, dayOfYear) : dataMaxDay
            const dayMap = new Map(rows.map(r => [r.day_of_year, r]))
            const filledRows: { day: number; cumulative: number; fatalities: number }[] = []
            let lastCumulative = 0
            for (let d = 1; d <= fillToDay; d++) {
                const row = dayMap.get(d)
                if (row) {
                    lastCumulative = row.cumulative
                    filledRows.push({ day: d, cumulative: row.cumulative, fatalities: row.fatalities })
                } else {
                    filledRows.push({ day: d, cumulative: lastCumulative, fatalities: 0 })
                }
            }

            // Current year gets thicker line by default
            const defaultWidth = isCurrentYear ? 4 : 2

            if (isYtd) {
                // YTD mode: clip all traces to today
                const clipped = filledRows.filter(r => r.day <= dayOfYear)
                traces.push({
                    type: "scatter",
                    mode: "lines",
                    name: `'${String(year).slice(2)}`,
                    x: clipped.map(r => toRefDate(year, r.day)),
                    y: clipped.map(r => r.cumulative),
                    customdata: clipped.map(r => r.fatalities > 0 ? ` +${r.fatalities}` : ''),
                    line: {
                        color: isGreyed ? fadeColor(color, { opacity: greyOpacity }) : color,
                        width: isActive ? 5 : (isGreyed ? 1 : defaultWidth),
                    },
                    legendrank: idx,
                    hovertemplate: `%{y}%{customdata}<extra>'${String(year).slice(2)}</extra>`,
                } as PlotData)
            } else if (isFaded && !isCurrentYear && filledRows.length > 0) {
                // Faded/Full mode: solid + faded future traces
                const solidRows = filledRows.filter(r => r.day <= dayOfYear)
                const futureRows = filledRows.filter(r => r.day >= dayOfYear)
                const yearLabel = `'${String(year).slice(2)}`
                const baseWidth = isActive ? 5 : (isGreyed ? 1 : defaultWidth)

                // Solid portion (up to today)
                if (solidRows.length > 0) {
                    traces.push({
                        type: "scatter",
                        mode: "lines",
                        name: yearLabel,
                        x: solidRows.map(r => toRefDate(year, r.day)),
                        y: solidRows.map(r => r.cumulative),
                        customdata: solidRows.map(r => r.fatalities > 0 ? ` +${r.fatalities}` : ''),
                        line: {
                            color: isGreyed ? fadeColor(color, { opacity: greyOpacity }) : color,
                            width: baseWidth,
                        },
                        legendrank: idx,
                        legendgroup: yearLabel,
                        hoverinfo: 'none',
                    } as PlotData)
                }

                // Future portion (faded by effectiveFadeOpacity)
                if (futureRows.length > 0) {
                    const futureColor = fadeColor(color, { opacity: effectiveFadeOpacity })
                    traces.push({
                        type: "scatter",
                        mode: "lines",
                        name: yearLabel,
                        x: futureRows.map(r => toRefDate(year, r.day)),
                        y: futureRows.map(r => r.cumulative),
                        customdata: futureRows.map(r => r.fatalities > 0 ? ` +${r.fatalities}` : ''),
                        line: {
                            color: isGreyed ? fadeColor(color, { opacity: greyOpacity * effectiveFadeOpacity }) : futureColor,
                            width: Math.max(1, baseWidth - 1),
                            dash: effectiveFadeOpacity >= 1.0 ? 'solid' : futureDash,
                        },
                        legendrank: idx,
                        legendgroup: yearLabel,
                        showlegend: false,
                        hoverinfo: 'none',
                    } as PlotData)
                }
            } else {
                // Current year in faded mode, or YTD mode fallthrough
                const yearLabel = `'${String(year).slice(2)}`
                const useCustom = isFaded
                traces.push({
                    type: "scatter",
                    mode: "lines",
                    name: yearLabel,
                    x: filledRows.map(r => toRefDate(year, r.day)),
                    y: filledRows.map(r => r.cumulative),
                    customdata: filledRows.map(r => r.fatalities > 0 ? ` +${r.fatalities}` : ''),
                    line: {
                        color: isGreyed ? fadeColor(color, { opacity: greyOpacity }) : color,
                        width: isActive ? 5 : (isGreyed ? 1 : defaultWidth),
                    },
                    legendrank: idx,
                    legendgroup: useCustom ? yearLabel : undefined,
                    ...(useCustom
                        ? { hoverinfo: 'none' as const }
                        : { hovertemplate: `%{y}%{customdata}<extra>${yearLabel}</extra>` }
                    ),
                } as PlotData)
            }
        }

        // Calculate y range for YTD mode
        let yRangeOverride: { range: [number, number] } | {} = {}
        if (isYtd) {
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

        if (isYtd) {
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
            if (!isYtd || day === 1) return month
            return `${month} ${day}`
        })

        // Add a vertical line at "today" in full-faded mode
        const shapes: Layout['shapes'] = []
        if (viewMode === 'full-faded' || viewMode === 'full') {
            shapes.push({
                type: 'line',
                x0: currentRefDate,
                x1: currentRefDate,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: { color: plotColors.textColor, width: 1, dash: 'dot' },
            })
        }

        const layout: Partial<Layout> = {
            showlegend: true,
            height: HEIGHT,
            margin: { t: 0, b: bottomMargin, l: 35, r: 5 },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            hovermode: isFaded ? "x" : "x unified",
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
                ...(isFaded ? {
                    showspikes: true,
                    spikemode: 'toaxis+across' as const,
                    spikethickness: 1,
                    spikedash: 'dot' as const,
                    spikecolor: plotColors.gridColor,
                } : {}),
                ...(isYtd ? { range: ['1999-12-31', currentRefDate] } : {}),
            },
            yaxis: {
                automargin: false,
                tickfont: { color: plotColors.textColor, size: 11 },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                rangemode: isYtd ? undefined : "tozero",
                autorange: !isYtd,
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
            shapes,
            dragmode: false,
        }

        return { data: traces, layout }
    }, [ytdRows, activeYear, colorScale, plotColors, legendPosition, viewMode, effectiveFadeOpacity, greyOpacity, futureDash])


    const isFadedMode = viewMode === 'full-faded' || viewMode === 'full'
    const customHover = useCustomHover({
        data: data as any,
        groupKey: (trace: any) => trace.legendgroup ?? trace.name ?? '',
    })

    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    const selectStyle = {
        padding: '2px 6px',
        borderRadius: '4px',
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: '12px',
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>YTD Deaths</a></h2>
            <div className={css.subtitle}>Fatalities, 2008–present{regionLabel ? ` · ${regionLabel}` : county ? ` · ${county} County` : ''}</div>
            <div style={{ position: 'relative' }}>
                <PlotWrapper
                    id={id}
                    data={data}
                    layout={layout}

                    onLegendClick={onLegendClick}
                    onLegendDoubleClick={onLegendDoubleClick}
                    onHoverTrace={setHoverTrace}
                    onResetSolo={resetSolo}
                    {...(isFadedMode ? { onHover: customHover.handleHover, onUnhover: customHover.handleUnhover } : {})}
                />
                {isFadedMode && customHover.isActive && customHover.position && customHover.x != null && (() => {
                    const { groups, x, position } = customHover
                    const dateLabel = typeof x === 'string' ? (() => {
                        const d = new Date(x + 'T00:00:00')
                        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                        return `${months[d.getMonth()]} ${d.getDate()}`
                    })() : ''
                    // Filter out traces that don't have data at this x (e.g. current year for future dates)
                    const exact = groups.filter(({ point }) => point.x === x)
                    // Sort by trace index (preserves chronological year order)
                    const sorted = [...exact].sort((a, b) => a.point.traceIndex - b.point.traceIndex)
                    return (
                        <div style={{
                            position: 'absolute',
                            left: position.x + 10,
                            top: HEIGHT / 2,
                            transform: 'translateY(-50%)',
                            background: 'var(--pltly-hover-bg, rgba(26, 26, 46, 0.95))',
                            border: '1px solid var(--pltly-hover-border, #555)',
                            borderRadius: 4,
                            padding: '6px 10px',
                            fontSize: 12,
                            color: 'var(--pltly-hover-color, #eee)',
                            pointerEvents: 'none',
                            whiteSpace: 'nowrap',
                            zIndex: 1000,
                        }}>
                            {dateLabel && <div style={{ fontWeight: 'bold', marginBottom: 2, borderBottom: '1px solid var(--pltly-hover-border, #555)', paddingBottom: 2 }}>{dateLabel}</div>}
                            {sorted.map(({ key, point }) => {
                                return (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
                                        <span style={{
                                            display: 'inline-block',
                                            width: 14,
                                            height: 3,
                                            background: (point.trace as any).line?.color ?? '#888',
                                        }} />
                                        <span>{key} : {point.y}{point.customdata ? String(point.customdata) : ''}</span>
                                    </div>
                                )
                            })}
                        </div>
                    )
                })()}
            </div>
            <ControlsGear
                open={controlsOpen}
                onToggle={setControlsOpen}
                extra={<>
                    <PlotInfo source="njsp">
                        <p style={{ margin: 0 }}>Some data arrives weeks or months after the fact, so current year numbers are especially subject to change.</p>
                    </PlotInfo>
                    <div className={css.buttonBar}>
                        {([['ytd', 'YTD'], ['full-faded', 'Faded'], ['full', 'Full']] as const).map(([mode, label]) => (
                            <button
                                key={mode}
                                className={viewMode === mode ? css.active : ''}
                                onClick={() => setViewMode(mode)}
                            >{label}</button>
                        ))}
                    </div>
                </>}
                bottomLegend={legendPosition === 'bottom'}
            >
                <div>
                    <label style={{ marginRight: '0.5em' }}>Colors:</label>
                    <select
                        value={colorScaleName}
                        onChange={e => setColorScaleName(e.target.value as ColorScaleName)}
                        style={selectStyle}
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
                        style={selectStyle}
                    >
                        <option value="bottom">Bottom</option>
                        <option value="right">Right</option>
                    </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
                    <label>Future:</label>
                    <input
                        type="range"
                        min={0.05}
                        max={1.0}
                        step={0.05}
                        value={viewMode === 'full' ? 1.0 : fadeOpacity}
                        onChange={e => {
                            const v = parseFloat(e.target.value)
                            setFadeOpacity(v)
                            // Dragging slider switches to Faded mode (unless at 100%)
                            if (v < 1.0 && viewMode === 'full') setViewMode('full-faded')
                        }}
                        disabled={viewMode === 'ytd'}
                        style={{ width: 80 }}
                    />
                    <span style={{ fontSize: 11, minWidth: '2.5em' }}>{Math.round((viewMode === 'full' ? 1.0 : fadeOpacity) * 100)}%</span>
                    <select
                        value={futureDash}
                        onChange={e => setFutureDash(e.target.value)}
                        style={selectStyle}
                    >
                        <option value="dot">Dot</option>
                        <option value="dash">Dash</option>
                        <option value="dashdot">Dash-dot</option>
                        <option value="solid">Solid</option>
                    </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
                    <label>Dim:</label>
                    <input
                        type="range"
                        min={0.05}
                        max={0.5}
                        step={0.05}
                        value={greyOpacity}
                        onChange={e => setGreyOpacity(parseFloat(e.target.value))}
                        style={{ width: 60 }}
                    />
                    <span style={{ fontSize: 11, minWidth: '2.5em' }}>{Math.round(greyOpacity * 100)}%</span>
                </div>
            </ControlsGear>
        </div>
    )
}
