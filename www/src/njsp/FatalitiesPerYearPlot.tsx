import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@rdub/duckdb/duckdb"
import { useRegisteredDb } from "@/src/tableData"
import { ProjectedCsv, YtcCsv } from "@/src/paths"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { Annotation } from "./plot"
import { CountySelect } from "@/src/county-select"
import A from "@/src/lib/a"
import { GitHub } from "@/src/socials"
import { PlotInfo } from "@/src/icons"
import { repoWithOwner } from "@/src/github"
import { usePlotColors } from "@/src/hooks/usePlotColors"
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

export type Props = {
    id?: string
    initialCounty?: string | null
    height?: number
}

export function FatalitiesPerYearPlot({ id = "per-year", initialCounty = null, height = 500 }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()
    const [county, setCounty] = useState<string | null>(initialCounty)
    const [soloType, setSoloType] = useState<Type | null>(null)
    const [hoverType, setHoverType] = useState<Type | null>(null)
    const [showProjected, setShowProjected] = useState(true)
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

    // Load ytc data from CSV
    const ytcDb = useRegisteredDb({ db, table: "ytc", url: YtcCsv })

    // Query for list of counties
    const countiesResult = useQuery<{ county: string }>({ db: ytcDb, query: countiesQuery, init: [] })
    const counties = useMemo(() => countiesResult.map(r => r.county), [countiesResult])

    const ytcQueryStr = useMemo(() => ytcQueryFn(county), [county])
    const ytRows = useQuery<YtRow>({ db: ytcDb, query: ytcQueryStr, init: [] })

    // Load projections from CSV
    const projectionsDb = useRegisteredDb({ db, table: "projected", url: ProjectedCsv })
    const projectionsQueryStr = useMemo(() => typeCountsQuery(county), [county])
    const [projections] = useQuery<TypeCounts>({ db: projectionsDb, query: projectionsQueryStr, init: [{ driver: 0, pedestrian: 0, cyclist: 0, passenger: 0 }] })

    // Determine active type (hover takes precedence over solo)
    const activeType = hoverType ?? soloType

    // Build plot data
    const { data, annotations, layout } = useMemo(() => {
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
                        marker: { color: PROJECTED_COLORS[type] },
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
                showlegend: true,
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
            showlegend: true,
            legend: {
                orientation: "h",
                x: 0.5,
                xanchor: "center",
                y: -0.12,  // Below x-ticks (tightened)
                yanchor: "top",
                font: { color: plotColors.textColor },
                tracegroupgap: 0,  // Tighten gap between legend items
                itemwidth: 30,  // Reduce width per item
            },
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
                dtick: 50,
                gridcolor: plotColors.gridColor,
                rangemode: "tozero",
                tickfont: { color: plotColors.textColor },
                automargin: true,
            },
            margin: { t: 10, r: 0, b: 50, l: 0 },
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
    }, [ytRows, projections, activeType, showProjected, height, plotColors, containerWidth])

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

    // Legend click handler
    const onLegendClick = useCallback((name: string) => {
        const typeName = name.replace(" (projected)", "") as Type
        if (!Types.includes(typeName)) return false
        if (soloType === typeName) {
            setSoloType(null)
            setHoverType(null)
        } else {
            setSoloType(typeName)
        }
        return false
    }, [soloType])

    // Legend double-click handler
    const onLegendDoubleClick = useCallback(() => {
        setSoloType(null)
        setHoverType(null)
        return false
    }, [])

    // Legend hover handlers
    const onLegendMouseOver = useCallback((name: string) => {
        const typeName = name.replace(" (projected)", "") as Type
        if (Types.includes(typeName)) {
            setHoverType(typeName)
        }
        return true
    }, [])

    const onLegendMouseOut = useCallback(() => {
        setHoverType(null)
        return true
    }, [])

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
    const countyLabel = county ? `${county} County` : "NJ"

    return (
        <div ref={containerRef}>
            <h2 id={id}>
                <a href={`#${id}`}>Car Crash Deaths</a>:
                <CountySelect county={county} setCounty={setCounty} Counties={counties} />
            </h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/fatalities_per_year_by_type.png"
                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onLegendMouseOver={onLegendMouseOver}
                onLegendMouseOut={onLegendMouseOut}
            />
            <div className={css.plotToolbarCompact}>
                <PlotInfo source="njsp">
                    {county === null && total2021 > 0 && total2022 > 0 ? (
                        <p style={{ margin: 0 }}>2021 and 2022 were the worst years in the NJSP record (since 2008), with {total2021} and {total2022} deaths, resp.</p>
                    ) : null}
                </PlotInfo>
            </div>
            {(curYearActual > 0 || curYearProjectedTotal > 0) && (
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
