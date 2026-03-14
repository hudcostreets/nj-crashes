import React, { useEffect, useMemo, useRef, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { MonthlyCsv, ProjectedCsv, YtcCsv } from "@/src/paths"
import { fadeColor, lightenColor, useSoloTrace } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { Annotation } from "./plot"
import { CountySelect } from "@/src/county-select"
import A from "@/src/lib/a"
import { GitHub } from "@/src/socials"
import { PlotInfo, Cyclist, Driver, Pedestrian, Passenger } from "@/src/icons"
import { repoWithOwner } from "@/src/github"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import css from "./plot.module.scss"

const estimationHref = `https://nbviewer.org/github/${repoWithOwner}/blob/main/njsp/update-projections.ipynb`

export type Type = "Cyclists" | "Drivers" | "Pedestrians" | "Passengers"
const Types: Type[] = ["Cyclists", "Drivers", "Pedestrians", "Passengers"]

// Trace colors - lightened for dark mode visibility
const COLORS: Record<Type, string> = {
    Cyclists: "#7c5295",  // Lightened from #320c56
    Drivers: "#a94c9a",   // Lightened from #781c6d
    Pedestrians: "#d85a6a",
    Passengers: "#f08030",
}

// Icon components for each type (used in custom legend)
const TYPE_ICONS: Record<Type, React.FC<{ style?: React.CSSProperties }>> = {
    Cyclists: Cyclist,
    Drivers: Driver,
    Pedestrians: Pedestrian,
    Passengers: Passenger,
}

// Lighter variants for projected data
const PROJECTED_COLORS: Record<Type, string> = {
    Cyclists: "#a888c8",
    Drivers: "#c890b8",
    Pedestrians: "#e8a0a8",
    Passengers: "#f5c080",
}

export type YtRow = {
    year: number
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
    total: number
}

type TypeCounts = {
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
}

const curYear = new Date().getFullYear()
const prvYear = curYear - 1

// Query for distinct counties
const countiesQuery = `
    SELECT DISTINCT county
    FROM read_csv_auto('ytc')
    WHERE county IS NOT NULL AND county != ''
    ORDER BY county
`

const typeCountsQuery = (county: string | null) => `
    SELECT
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger
    FROM read_csv_auto('projected')
    ${county ? `WHERE county = '${county}'` : ``}
`

// Query for ytc data
const ytcQueryFn = (county: string | null) => `
    SELECT
        year,
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger,
        CAST(sum(driver + pedestrian + cyclist + passenger) as INT) as total
    FROM read_csv_auto('ytc')
    ${county ? `WHERE county = '${county}'` : ``}
    GROUP BY year
    ORDER BY year
`

const typesMap: Record<Type, keyof TypeCounts> = {
    Cyclists: "cyclist",
    Drivers: "driver",
    Pedestrians: "pedestrian",
    Passengers: "passenger",
}

type MonthlyRow = {
    date: string
    year: number
    month: number
    fatalities: number
    driver: number
    passenger: number
    pedestrian: number
    cyclist: number
    avg_12mo: number
}

const monthlyQueryFn = (county: string | null, cc: number | null, mc: number | null) => {
    let where: string
    if (cc !== null && mc !== null) {
        where = `WHERE cc = ${cc} AND mc = ${mc}`
    } else if (county) {
        where = `WHERE county = '${county}' AND mc IS NULL`
    } else {
        where = `WHERE county IS NULL AND cc IS NULL`
    }
    return `
    SELECT date, year, month, fatalities, driver, passenger, pedestrian, cyclist, avg_12mo
    FROM read_csv_auto('monthly')
    ${where}
    ORDER BY date
`
}

// Query yearly data from monthly CSV (for muni-level, where ytc doesn't have data)
const yearlyFromMonthlyQueryFn = (cc: number, mc: number) => `
    SELECT
        year,
        CAST(SUM(driver) as INT) as driver,
        CAST(SUM(pedestrian) as INT) as pedestrian,
        CAST(SUM(cyclist) as INT) as cyclist,
        CAST(SUM(passenger) as INT) as passenger,
        CAST(SUM(fatalities) as INT) as total
    FROM read_csv_auto('monthly')
    WHERE cc = ${cc} AND mc = ${mc}
    GROUP BY year
    ORDER BY year
`

type TimeGranularity = 'year' | 'month'

export type Props = {
    id?: string
    initialCounty?: string | null
    cc?: number | null
    mc?: number | null
    regionLabel?: string | null
    height?: number
}

export function FatalitiesPerYearPlot({ id = "per-year", initialCounty = null, cc: propCc = null, mc: propMc = null, regionLabel, height = 500 }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()
    const [county, setCounty] = useState<string | null>(initialCounty)
    // Sync with external county prop (geo filter)
    useEffect(() => { setCounty(initialCounty) }, [initialCounty])
    // Municipality-level: use cc/mc from props (no county dropdown when muni-level)
    const hasMuniFilter = propCc !== null && propMc !== null
    const [hoverTrace, setHoverTrace] = useState<string | null>(null)
    const [showProjected, setShowProjected] = useState(true)
    const [projLighten, setProjLighten] = useSessionStorage<number>('njsp-deaths-projLighten', 0.85)
    const [projSolidity, setProjSolidity] = useSessionStorage<number>('njsp-deaths-projSolidity', 0.35)
    const [timeGranularity, setTimeGranularity] = useSessionStorage<TimeGranularity>('njsp-deaths-timeGranularity', 'year')
    const containerRef = useRef<HTMLDivElement>(null)
    const [containerWidth, setContainerWidth] = useState(800)  // Default to reasonable width before ResizeObserver fires

    // Track container width for responsive annotation sizing
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const updateWidth = () => setContainerWidth(container.clientWidth)
        updateWidth()

        const observer = new ResizeObserver(updateWidth)
        observer.observe(container)
        return () => observer.disconnect()
    }, [])

    // Load data sources
    const ytcDb = useRegisteredDb({ db, table: "ytc", url: YtcCsv })
    const monthlyDb = useRegisteredDb({ db, table: "monthly", url: MonthlyCsv })
    const projectionsDb = useRegisteredDb({ db, table: "projected", url: ProjectedCsv })

    // Query for list of counties
    const countiesResult = useQuery<{ county: string }>({ db: ytcDb, query: countiesQuery, init: [] })
    const counties = useMemo(() => countiesResult.map(r => r.county), [countiesResult])

    // Yearly data: muni-level aggregates from monthly; otherwise from ytc
    const ytcQueryStr = useMemo(() => ytcQueryFn(county), [county])
    const ytcRows = useQuery<YtRow>({ db: ytcDb, query: ytcQueryStr, init: [] })
    const muniYearlyQueryStr = useMemo(
        () => hasMuniFilter ? yearlyFromMonthlyQueryFn(propCc!, propMc!) : null,
        [hasMuniFilter, propCc, propMc],
    )
    const muniYtRows = useQuery<YtRow>({ db: monthlyDb, query: muniYearlyQueryStr, init: [] })
    const ytRows = hasMuniFilter ? muniYtRows : ytcRows

    // Projections (county-level only, not available at muni level)
    const projectionsQueryStr = useMemo(() => typeCountsQuery(county), [county])
    const [projections] = useQuery<TypeCounts>({ db: projectionsDb, query: projectionsQueryStr, init: [{ driver: 0, pedestrian: 0, cyclist: 0, passenger: 0 }] })
    const monthlyQueryStr = useMemo(() => monthlyQueryFn(county, propCc ?? null, propMc ?? null), [county, propCc, propMc])
    const monthlyRows = useQuery<MonthlyRow>({ db: monthlyDb, query: monthlyQueryStr, init: [] })

    const isMonthly = timeGranularity === 'month'

    // Solo trace management via pltly
    const traceNames = useMemo(() => isMonthly ? [...Types, '12-mo avg'] : [...Types], [isMonthly])
    // Normalize hover trace (strip " (projected)" suffix)
    const normalizedHover = useMemo(() => {
        if (!hoverTrace) return null
        const base = hoverTrace.replace(" (projected)", "") as Type
        return Types.includes(base) ? base : null
    }, [hoverTrace])
    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(traceNames, normalizedHover)
    const activeType = activeTrace as Type | null

    // Build plot data
    const { data, annotations, layout } = useMemo(() => {
        // Monthly mode — stacked bars by victim type + 12-mo avg line
        if (isMonthly) {
            if (!monthlyRows.length) {
                return { data: [], annotations: [], layout: {} as Partial<Layout> }
            }

            const now = new Date()
            const currentYear = now.getFullYear()
            const currentMonth = now.getMonth() + 1
            const filteredRows = monthlyRows.filter(r =>
                r.year < currentYear || (r.year === currentYear && r.month < currentMonth)
            )

            const dates = filteredRows.map(r => r.date)

            // Determine which types are visible (solo trace support)
            const visibleTypes = activeType && Types.includes(activeType)
                ? new Set([activeType])
                : new Set(Types)
            const avgActive = activeType === '12-mo avg' as any
            const avgGreyed = activeType !== null && !avgActive

            // Compute 12-mo avg: use precomputed avg_12mo for all types,
            // or compute from the solo'd type's values
            const soloType = activeType && Types.includes(activeType) ? activeType : null
            const avgValues: (number | null)[] = filteredRows.map((r, i) => {
                if (i < 11) return null
                if (!soloType) return r.avg_12mo
                const col = typesMap[soloType]
                let sum = 0
                for (let j = i - 11; j <= i; j++) {
                    sum += filteredRows[j][col] as number
                }
                return sum / 12
            })

            // Stacked bars by victim type
            // Fade bars when 12-mo avg is highlighted
            const barsGreyed = avgActive
            const traces: PlotData[] = Types.map(type => {
                const col = typesMap[type]
                const isVisible = visibleTypes.has(type)
                const isGreyed = barsGreyed || (activeType !== null && !isVisible)
                return {
                    type: "bar",
                    name: type,
                    legendgroup: type,
                    x: dates,
                    y: filteredRows.map(r => {
                        const typed = r[col] as number
                        // Pre-2020 data has no type breakdown; show full total on Drivers bar
                        if (typed === 0 && r.driver === 0 && r.passenger === 0 && r.pedestrian === 0 && r.cyclist === 0) {
                            return type === 'Drivers' ? r.fatalities : 0
                        }
                        return typed
                    }),
                    marker: {
                        color: isGreyed ? fadeColor(COLORS[type], { opacity: 0.3 }) : COLORS[type],
                        line: { color: 'transparent', width: 0 },
                    },
                    visible: isVisible || activeType === null || avgActive ? true : "legendonly",
                    hovertemplate: `%{y}<extra>${type}</extra>`,
                } as PlotData
            })

            // 12-mo avg line — tinted toward solo'd type color, or emphasized when hovered
            const avgColor = soloType
                ? lightenColor(COLORS[soloType], 0.5)
                : plotColors.textColor
            traces.push({
                type: "scatter",
                mode: "lines",
                name: "12-mo avg",
                x: dates,
                y: avgValues,
                line: {
                    color: avgColor,
                    width: avgActive ? 6 : 4,
                },
                hovertemplate: `%{y:.1f}<extra>12-mo avg</extra>`,
            } as PlotData)

            const layout: Partial<Layout> = {
                barmode: "stack",
                showlegend: false,
                height,
                margin: { t: 10, b: 30, l: 40, r: 0 },
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
                    tick0: "2008-01-01",
                    dtick: "M12",
                    tickformat: "'%y",
                    hoverformat: "%b '%y",
                    fixedrange: true,
                },
                yaxis: {
                    automargin: true,
                    tickfont: { color: plotColors.textColor },
                    gridcolor: plotColors.gridColor,
                    fixedrange: true,
                    rangemode: "tozero",
                },
                dragmode: false,
            }

            return { data: traces, annotations: [], layout }
        }

        // Yearly mode
        if (!ytRows.length) {
            return { data: [], annotations: [], layout: {} as Partial<Layout> }
        }

        const rows = ytRows.map(row => ({ ...row }))

        // Calculate adaptive annotation font size based on available width per bar
        const numBars = ytRows.length + (ytRows.some(r => r.year === curYear) ? 0 : 1)
        const widthPerBar = containerWidth / numBars
        // Scale font from 10px (cramped) to 15px (spacious)
        const annotationFontSize = Math.max(10, Math.min(15, Math.floor(widthPerBar / 2.5)))

        // Add current year row if it doesn't exist (for projections)
        const hasCurrentYear = rows.some(r => r.year === curYear)
        if (!hasCurrentYear && projections) {
            const projTotal = projections.driver + projections.pedestrian + projections.cyclist + projections.passenger
            if (projTotal > 0) {
                rows.push({
                    year: curYear,
                    driver: 0,
                    pedestrian: 0,
                    cyclist: 0,
                    passenger: 0,
                    total: 0,
                })
            }
        }

        const lastRow = rows[rows.length - 1]
        const lastYear = lastRow?.year

        // Calculate projected remainders for current year (per type)
        const projectedRemainder: Record<string, number> = {}
        if (lastYear === curYear) {
            for (const type of Types) {
                const col = typesMap[type]
                const actual = lastRow[col] || 0
                const projected = projections[col] || 0
                projectedRemainder[col] = Math.max(0, projected - actual)
            }
        }

        // Determine which types are visible
        const visibleTypes = activeType
            ? new Set([activeType])
            : new Set(Types)

        // Build traces: actual data for each type
        const traces: PlotData[] = Types.map(type => {
            const col = typesMap[type]
            return {
                type: "bar",
                name: type,
                legendgroup: type,
                x: rows.map(r => r.year),
                y: rows.map(r => r[col]),
                marker: { color: COLORS[type] },
                texttemplate: "%{y:d}",
                textposition: visibleTypes.size === 1 ? "auto" : "inside",
                visible: visibleTypes.has(type) ? true : "legendonly",
                hovertemplate: `%{y}<extra>${type}</extra>`,
            } as PlotData
        })

        // Add invisible trace for total (shows once in unified hover)
        if (visibleTypes.size === Types.length) {
            traces.push({
                type: "scatter",
                mode: "markers",
                name: "Total",
                showlegend: false,
                x: rows.map(r => r.year),
                y: rows.map(r => r.driver + r.pedestrian + r.cyclist + r.passenger),
                marker: { size: 0, opacity: 0 },
                hovertemplate: `<b>%{y}</b><extra>Total</extra>`,
            } as PlotData)
        }

        // Add projected remainder traces (only for current year, stacked by type)
        let hasProjected = false
        if (showProjected && lastYear === curYear) {
            for (const type of Types) {
                const col = typesMap[type]
                const remainder = projectedRemainder[col] || 0
                if (remainder > 0) {
                    hasProjected = true
                    const actual = lastRow[col] || 0
                    const projTotal = actual + remainder
                    traces.push({
                        type: "bar",
                        name: `${type} (projected)`,
                        legendgroup: type,  // Same group as actual
                        showlegend: false,  // Don't show separate legend entry
                        x: [curYear],  // Only current year
                        y: [remainder],
                        marker: {
                            color: COLORS[type],
                            pattern: {
                                shape: '/',
                                size: 6,
                                solidity: projSolidity,
                                fgcolor: COLORS[type],
                                fgopacity: 1,
                                bgcolor: lightenColor(COLORS[type], projLighten),
                            },
                        } as any,
                        texttemplate: "%{y:d}*",
                        textposition: "inside",
                        textangle: 0,  // Force upright text
                        hovertemplate: `${curYear} est: ${projTotal} +%{y}<extra>${type}*</extra>`,
                        visible: visibleTypes.has(type) ? true : "legendonly",
                    } as PlotData)
                }
            }
        }

        // Add legend entry for projected
        if (hasProjected) {
            traces.push({
                type: "bar",
                name: "* projected",
                x: [null],
                y: [null],
                marker: { color: "#ccc" },
                showlegend: false,
            } as PlotData)
        }

        // Build annotations (totals above bars)
        const annotations: Annotation[] = []
        if (visibleTypes.size === Types.length) {
            // Show all year totals when all types visible
            rows.forEach(row => {
                const actual = row.driver + row.pedestrian + row.cyclist + row.passenger
                // Add projected remainder for current year
                let projected = 0
                if (showProjected && row.year === curYear) {
                    for (const type of Types) {
                        const col = typesMap[type]
                        projected += projectedRemainder[col] || 0
                    }
                }
                const total = actual + projected
                // Skip if nothing to show
                if (total === 0) return
                annotations.push({
                    x: row.year,
                    y: total,
                    text: projected > 0 ? `${total}*` : `${total}`,
                    showarrow: false,
                    yshift: 14,
                    font: { color: plotColors.textColor, size: annotationFontSize },
                })
            })
        } else if (activeType && showProjected && lastYear === curYear) {
            // In solo mode, show current year projected total for the active type only
            const col = typesMap[activeType]
            const curYearRow = rows.find(r => r.year === curYear)
            if (curYearRow) {
                const actual = curYearRow[col] || 0
                const projected = projectedRemainder[col] || 0
                const total = actual + projected
                // Skip annotation if actual is 0 (projected bar text already shows total)
                if (projected > 0 && actual > 0) {
                    annotations.push({
                        x: curYear,
                        y: total,
                        text: `${total}*`,
                        showarrow: false,
                        yshift: 14,
                        font: { color: plotColors.textColor, size: annotationFontSize },
                    })
                }
            }
        }


        const layout: Partial<Layout> = {
            barmode: "stack",
            showlegend: false,
            xaxis: {
                fixedrange: true,
                dtick: 1,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                tickangle: -45,  // Slant from LL to UR
                automargin: true,
                // Limit range to actual data years (prevent auto-extension)
                range: [rows[0].year - 0.5, rows[rows.length - 1].year + 0.5],
                // Format years as 'yy
                tickvals: rows.map(r => r.year),
                ticktext: rows.map(r => `'${String(r.year).slice(2)}`),
            },
            yaxis: {
                fixedrange: true,
                gridcolor: plotColors.gridColor,
                rangemode: "tozero",
                tickfont: { color: plotColors.textColor },
            },
            margin: { t: 10, r: 0, b: 30, l: 40 },
            annotations,
            dragmode: false,
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            height,
            hovermode: "x unified",
            hoverlabel: {
                bgcolor: '#1a1a2e',  // Dark background for hover tooltip
                bordercolor: plotColors.gridColor,
                font: { color: '#ffffff' },  // White text
            },
        }

        return { data: traces, annotations, layout, projectedRemainder }
    }, [ytRows, projections, activeType, showProjected, projLighten, projSolidity, height, plotColors, containerWidth, isMonthly, monthlyRows])

    // Compute year totals for summary text
    const yearTotals = useMemo(() => {
        const totals: Record<number, { actual: number; projected: number }> = {}
        for (const row of ytRows) {
            totals[row.year] = { actual: row.total, projected: 0 }
        }
        // Calculate projected total from projections data
        const projectedTotal = projections
            ? projections.driver + projections.pedestrian + projections.cyclist + projections.passenger
            : 0
        // Add projected remainder to current year (or create entry if no actual data yet)
        if (projectedTotal > 0) {
            const curYearActual = totals[curYear]?.actual ?? 0
            totals[curYear] = {
                actual: curYearActual,
                projected: Math.max(0, projectedTotal - curYearActual),
            }
        }
        return totals
    }, [ytRows, projections])


    if (!data.length) {
        return <div style={{ height: `${height}px` }}>Loading...</div>
    }

    // Summary text data
    const curYearData = yearTotals[curYear]
    const prvYearData = yearTotals[prvYear]
    const curYearActual = curYearData?.actual ?? 0
    const curYearProjectedTotal = curYearActual + (curYearData?.projected ?? 0)
    const prvYearTotal = prvYearData?.actual ?? 0
    const total2021 = yearTotals[2021]?.actual ?? 0
    const total2022 = yearTotals[2022]?.actual ?? 0
    const countyLabel = regionLabel ?? (county ? `${county} County` : "NJ")

    return (
        <div ref={containerRef}>
            <h2 id={id}>
                <a href={`#${id}`}>Car Crash Deaths</a>
                {!initialCounty && !hasMuniFilter && <>:{' '}<CountySelect county={county} setCounty={setCounty} Counties={counties} /></>}
            </h2>
            <div className={css.subtitle}>Fatalities, 2008–present{regionLabel ? ` · ${regionLabel}` : initialCounty ? ` · ${initialCounty} County` : ''}</div>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}

                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onHoverTrace={setHoverTrace}
                onResetSolo={resetSolo}
            />
            <div className={css.plotToolbarCompact}>
                <PlotInfo source="njsp">
                    {!isMonthly && county === null && total2021 > 0 && total2022 > 0 ? (
                        <p style={{ margin: 0 }}>2021 and 2022 were the worst years in the NJSP record (since 2008), with {total2021} and {total2022} deaths, resp.</p>
                    ) : null}
                </PlotInfo>
                <div className={css.buttonBar}>
                    {([['year', 'By Year'], ['month', 'By Month']] as const).map(([mode, label]) => (
                        <button
                            key={mode}
                            className={timeGranularity === mode ? css.active : ''}
                            onClick={() => setTimeGranularity(mode)}
                        >{label}</button>
                    ))}
                </div>
                <div className={css.iconLegend}>
                    {Types.map(type => {
                        const IconComponent = TYPE_ICONS[type]
                        const isSolo = activeType === type
                        const isGreyed = activeType !== null && !isSolo
                        return (
                            <span
                                key={type}
                                className={`${css.iconLegendItem} ${isSolo ? css.solo : ''} ${isGreyed ? css.greyed : ''}`}
                                onClick={() => {
                                    const event = { data: traceNames.map(n => ({ name: n })), curveNumber: traceNames.indexOf(type) }
                                    onLegendClick(event)
                                }}
                                onDoubleClick={() => onLegendDoubleClick()}
                                onMouseEnter={() => setHoverTrace(type)}
                                onMouseLeave={() => setHoverTrace(null)}
                            >
                                <IconComponent style={{ fill: COLORS[type] }} />
                                <span className={css.iconLegendLabel}>{type}</span>
                            </span>
                        )
                    })}
                    {isMonthly && (() => {
                        const soloType = activeType && Types.includes(activeType) ? activeType : null
                        const avgLiColor = soloType ? lightenColor(COLORS[soloType], 0.5) : undefined
                        return (
                            <span
                                className={`${css.iconLegendItem} ${activeType === '12-mo avg' as any ? css.solo : ''}`}
                                onClick={() => {
                                    const event = { data: traceNames.map(n => ({ name: n })), curveNumber: traceNames.indexOf('12-mo avg') }
                                    onLegendClick(event)
                                }}
                                onDoubleClick={() => onLegendDoubleClick()}
                                onMouseEnter={() => setHoverTrace('12-mo avg')}
                                onMouseLeave={() => setHoverTrace(null)}
                            >
                                <span className={css.iconLegendLine} style={avgLiColor ? { background: avgLiColor } : undefined} />
                                <span className={css.iconLegendLabel} style={avgLiColor ? { color: avgLiColor } : undefined}>12-mo avg</span>
                            </span>
                        )
                    })()}
                    {!isMonthly && showProjected && (
                        <details style={{ display: 'inline', position: 'relative', cursor: 'pointer' }}>
                            <summary className={css.iconLegendItem} style={{ opacity: 0.7, listStyle: 'none', display: 'inline-flex' }}>
                                <span className={css.iconLegendSwatch} style={{
                                    background: `repeating-linear-gradient(
                                        -45deg,
                                        ${COLORS.Drivers},
                                        ${COLORS.Drivers} ${Math.round(projSolidity * 4)}px,
                                        ${lightenColor(COLORS.Drivers, projLighten)} ${Math.round(projSolidity * 4)}px,
                                        ${lightenColor(COLORS.Drivers, projLighten)} 4px
                                    )`,
                                }} />
                                <span className={css.iconLegendLabel}>* projected</span>
                            </summary>
                            <div style={{ position: 'absolute', bottom: '100%', right: 0, zIndex: 100, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 4, padding: '0.4em 0.6em', fontSize: 11, whiteSpace: 'nowrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em', marginBottom: '0.3em' }}>
                                    <label>Stripe:</label>
                                    <input type="range" min={0.1} max={0.8} step={0.05} value={projSolidity} onChange={e => setProjSolidity(parseFloat(e.target.value))} style={{ width: 60 }} />
                                    <span>{Math.round(projSolidity * 100)}%</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
                                    <label>Lighten:</label>
                                    <input type="range" min={0.3} max={0.95} step={0.05} value={projLighten} onChange={e => setProjLighten(parseFloat(e.target.value))} style={{ width: 60 }} />
                                    <span>{Math.round(projLighten * 100)}%</span>
                                </div>
                            </div>
                        </details>
                    )}
                </div>
            </div>
            {!isMonthly && !hasMuniFilter && (curYearActual > 0 || curYearProjectedTotal > 0) && (
                <p className={css.plotStats}>
                    {curYearActual > 0 ? (
                        <>
                            {countyLabel} has {curYearActual} reported deaths in {curYear} so far
                            {curYearProjectedTotal > curYearActual ? (
                                <>, and <A href={estimationHref}>is on pace</A> for {curYearProjectedTotal}{curYearProjectedTotal > prvYearTotal ? `, exceeding ${prvYear}'s ${prvYearTotal}` : ""}</>
                            ) : null}.
                        </>
                    ) : curYearProjectedTotal > 0 ? (
                        <>
                            {countyLabel} <A href={estimationHref}>is on pace</A> for {curYearProjectedTotal} deaths in {curYear}
                            {curYearProjectedTotal > prvYearTotal ? `, exceeding ${prvYear}'s ${prvYearTotal}` : ""}.
                        </>
                    ) : null}
                </p>
            )}
        </div>
    )
}
