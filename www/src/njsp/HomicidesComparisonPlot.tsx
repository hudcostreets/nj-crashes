import React, { useCallback, useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@rdub/duckdb/duckdb"
import { useRegisteredDb } from "@/src/tableData"
import { CrashHomicideCsv } from "@/src/paths"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo, DataSource } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import css from "./plot.module.scss"

const HEIGHT = 450

// Data sources for this plot
const SOURCES: DataSource[] = [
    { label: "NJ State Police", href: "https://njsp.njoag.gov/fatal-crash-statistics/", note: "Traffic deaths (fatal crashes)" },
    { label: "NJ State Police UCR", href: "https://nj.gov/oag/njsp/ucr/uniform-crime-reports.shtml", note: "Homicide data" },
    { label: "Disaster Center", href: "https://www.disastercenter.com/crime/njcrimn.htm", note: "Historical homicide data" },
]

// Original colors from the JSON spec
const TRAFFIC_COLOR = '#e06080'  // Pinkish red
const HOMICIDE_COLOR = '#60a0e0'  // Light blue
const RATIO_COLOR = '#ffffff'  // White

export type Props = {
    id?: string
}

type CrashHomicideRow = {
    year: number
    traffic_deaths: number
    homicides: number
    ratio: number
}

// Query to get crash-homicide data
const crashHomicideQuery = `
    SELECT year, traffic_deaths, homicides, ratio
    FROM read_csv_auto('crash_homicide')
    ORDER BY year
`

// Helper to fade colors
function fadeColor(color: string | undefined): string {
    if (!color) return 'rgba(128, 128, 128, 0.35)'
    if (color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        return `rgba(${r}, ${g}, ${b}, 0.35)`
    }
    return color
}

export function HomicidesComparisonPlot({ id = "vs-homicides" }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    // Legend interaction state
    const [soloTrace, setSoloTrace] = useState<string | null>(null)
    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    // Load crash-homicide data
    const crashHomicideDb = useRegisteredDb({ db, table: "crash_homicide", url: CrashHomicideCsv })
    const rows = useQuery<CrashHomicideRow>({ db: crashHomicideDb, query: crashHomicideQuery, init: [] })

    // Determine active trace (hover takes precedence over solo)
    const activeTrace = hoverTrace ?? soloTrace

    // Build plot data
    const { data, layout } = useMemo(() => {
        if (!rows.length) {
            return { data: [], layout: {} as Partial<Layout> }
        }

        const years = rows.map(r => r.year)
        const trafficDeaths = rows.map(r => r.traffic_deaths)
        const homicides = rows.map(r => r.homicides)
        const ratios = rows.map(r => r.ratio)

        const trafficActive = activeTrace === 'Traffic deaths'
        const homicidesActive = activeTrace === 'Homicides'
        const ratioActive = activeTrace === 'Ratio'
        const trafficGreyed = activeTrace !== null && !trafficActive
        const homicidesGreyed = activeTrace !== null && !homicidesActive
        const ratioGreyed = activeTrace !== null && !ratioActive

        const traces: PlotData[] = [
            // Traffic deaths bar
            {
                type: "bar",
                name: "Traffic deaths",
                x: years,
                y: trafficDeaths,
                marker: {
                    color: trafficGreyed ? fadeColor(TRAFFIC_COLOR) : TRAFFIC_COLOR,
                },
                hovertemplate: `%{y} traffic deaths<extra></extra>`,
            } as PlotData,
            // Homicides bar
            {
                type: "bar",
                name: "Homicides",
                x: years,
                y: homicides,
                marker: {
                    color: homicidesGreyed ? fadeColor(HOMICIDE_COLOR) : HOMICIDE_COLOR,
                },
                hovertemplate: `%{y} homicides<extra></extra>`,
            } as PlotData,
            // Ratio line (secondary y-axis)
            {
                type: "scatter",
                mode: "lines",
                name: "Ratio",
                x: years,
                y: ratios,
                yaxis: "y2",
                line: {
                    color: ratioGreyed ? fadeColor(RATIO_COLOR) : RATIO_COLOR,
                    width: ratioActive ? 8 : (ratioGreyed ? 3 : 5),
                },
                hovertemplate: `%{y:.2f}x<extra>Ratio</extra>`,
            } as PlotData,
        ]

        const layout: Partial<Layout> = {
            showlegend: true,
            height: HEIGHT,
            margin: { t: 0, b: 40, l: 0, r: 0 },
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
                tickmode: 'array',
                tickvals: years,
                ticktext: years.map(y => `'${String(y).slice(2)}`),
                domain: [0.0, 0.94],
            },
            yaxis: {
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                rangemode: "tozero",
                range: [0, 800],
                dtick: 100,
                title: {
                    text: "Deaths",
                    font: { color: plotColors.textColor },
                    standoff: 10,
                },
            },
            yaxis2: {
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                fixedrange: true,
                overlaying: "y",
                side: "right",
                range: [1, 2.6],
                dtick: 0.2,
                title: {
                    text: "Ratio",
                    font: { color: plotColors.textColor },
                    standoff: 5,
                },
            },
            legend: {
                font: { color: plotColors.textColor },
                orientation: 'h' as const,
                x: 0.5,
                xanchor: 'center' as const,
                y: -0.08,
                yanchor: 'top' as const,
            },
            dragmode: false,
        }

        return { data: traces, layout }
    }, [rows, activeTrace, plotColors])

    // Legend click handler
    const onLegendClick = useCallback((name: string) => {
        if (soloTrace === name) {
            setSoloTrace(null)
            setHoverTrace(null)
        } else {
            setSoloTrace(name)
        }
        return false
    }, [soloTrace])

    // Legend double-click handler
    const onLegendDoubleClick = useCallback(() => {
        setSoloTrace(null)
        setHoverTrace(null)
        return false
    }, [])

    // Legend hover handlers
    const onLegendMouseOver = useCallback((name: string) => {
        setHoverTrace(name)
        return true
    }, [])

    const onLegendMouseOut = useCallback(() => {
        setHoverTrace(null)
        return true
    }, [])

    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>NJ Traffic Deaths vs. Homicides</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/crash_homicide_cmp.png"
                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onLegendMouseOver={onLegendMouseOver}
                onLegendMouseOut={onLegendMouseOut}
            />
            <div className={css.plotToolbarCompact}>
                <PlotInfo source={SOURCES} />
            </div>
            <p className={css.plotStats}>
                Car crashes kill twice as many people as homicides in NJ. In 2022, crashes killed 2.4x as many people, the largest disparity on record.
            </p>
        </div>
    )
}
