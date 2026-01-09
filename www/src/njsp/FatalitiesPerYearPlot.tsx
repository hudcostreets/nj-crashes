import React, { useCallback, useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@rdub/duckdb/duckdb"
import { useRegisteredDb } from "@/src/tableData"
import { ProjectedCsv, YtcCsv } from "@/src/paths"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { Annotation } from "./plot"

export type Type = "Cyclists" | "Drivers" | "Pedestrians" | "Passengers"
const Types: Type[] = ["Cyclists", "Drivers", "Pedestrians", "Passengers"]

// Trace colors matching the original plot
const COLORS: Record<Type, string> = {
    Cyclists: "#320c56",
    Drivers: "#781c6d",
    Pedestrians: "#ba3853",
    Passengers: "#ed6925",
}

// Lighter variants for projected data
const PROJECTED_COLORS: Record<Type, string> = {
    Cyclists: "#7a5a9e",
    Drivers: "#b868a8",
    Pedestrians: "#d88898",
    Passengers: "#f5b875",
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
    county?: string | null
    height?: number
}

export function FatalitiesPerYearPlot({ id = "per-year", county = null, height = 400 }: Props) {
    const db = useDb()
    const [soloType, setSoloType] = useState<Type | null>(null)
    const [hoverType, setHoverType] = useState<Type | null>(null)
    const [showProjected, setShowProjected] = useState(true)

    // Load ytc data from CSV
    const ytcDb = useRegisteredDb({ db, table: "ytc", url: YtcCsv })
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
                hovertemplate: `${type}: %{y}<extra></extra>`,
            } as PlotData
        })

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
                        hovertemplate: `${type}<br>Rest of year*: %{y}<br><b>${curYear} total*: ${projTotal}</b><extra></extra>`,
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
                annotations.push({
                    x: row.year,
                    y: total,
                    text: projected > 0 ? `${total}*` : `${total}`,
                    showarrow: false,
                    yshift: 10,
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
                if (projected > 0) {
                    annotations.push({
                        x: curYear,
                        y: total,
                        text: `${total}*`,
                        showarrow: false,
                        yshift: 10,
                    })
                }
            }
        }


        const layout: Partial<Layout> = {
            barmode: "stack",
            hovermode: "x",
            showlegend: true,
            legend: {
                orientation: "h",
                x: 0.5,
                xanchor: "center",
                y: -0.05,
                yanchor: "top",
            },
            xaxis: {
                fixedrange: true,
                dtick: 1,
            },
            yaxis: {
                fixedrange: true,
                dtick: 50,
                gridcolor: "#ccc",
                rangemode: "tozero",
            },
            margin: { t: 10, r: 10, b: 40, l: 40 },
            annotations,
            dragmode: false,
            paper_bgcolor: "white",
            plot_bgcolor: "white",
            height,
        }

        return { data: traces, annotations, layout }
    }, [ytRows, projections, activeType, showProjected, height])

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

    return (
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
    )
}
