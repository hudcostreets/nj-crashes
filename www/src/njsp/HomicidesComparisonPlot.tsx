import React, { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { CrashHomicideCsv } from "@/src/paths"
import { fadeColor, useSoloTrace } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo, DataSource } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import css from "./plot.module.scss"

const HEIGHT = 450

type CrashSource = 'njsp' | 'njdot'

// Data sources for this plot
const SOURCES: DataSource[] = [
    { label: "NJ State Police", href: "https://njsp.njoag.gov/fatal-crash-statistics/", note: "Traffic deaths (fatal crashes)" },
    { label: "NJ State Police UCR", href: "https://njsp.njoag.gov/crime-reports/", note: "Homicide data" },
    { label: "Disaster Center", href: "https://www.disastercenter.com/crime/njcrimn.htm", note: "Historical homicide data" },
]

// Original colors from the JSON spec
const TRAFFIC_COLOR = '#e06080'  // Pinkish red
const HOMICIDE_COLOR = '#60a0e0'  // Light blue

export type Props = {
    id?: string
    county?: string | null
    cc?: number | null
    mc?: number | null
}

type CrashHomicideRow = {
    year: number
    traffic_deaths: number
    homicides: number
    ratio: number | null
}

// Query to get crash-homicide data (filtered by county and source)
const crashHomicideQueryFn = (county: string | null, source: CrashSource) => `
    SELECT year, traffic_deaths, homicides, ratio
    FROM read_csv_auto('crash_homicide')
    WHERE source = '${source}'
      AND ${county ? `county = '${county}'` : `county IS NULL OR county = ''`}
    ORDER BY year
`

export function HomicidesComparisonPlot({ id = "vs-homicides", county }: Props) {
    // Note: crash-homicide data only exists at statewide and county level (no muni breakdowns)
    const db = useDb()
    const plotColors = usePlotColors()

    const [hoverTrace, setHoverTrace] = useState<string | null>(null)
    // Only show source toggle for statewide (county data is NJSP-only)
    const [crashSource, setCrashSource] = useSessionStorage<CrashSource>('homicides-crash-source', 'njsp')
    // Force NJSP for county views
    const effectiveSource = county ? 'njsp' as CrashSource : crashSource

    // Load crash-homicide data
    const crashHomicideDb = useRegisteredDb({ db, table: "crash_homicide", url: CrashHomicideCsv })
    const crashHomicideQuery = useMemo(() => crashHomicideQueryFn(county ?? null, effectiveSource), [county, effectiveSource])
    const rows = useQuery<CrashHomicideRow>({ db: crashHomicideDb, query: crashHomicideQuery, init: [] })

    const TRACE_NAMES = useMemo(() => ['Traffic deaths', 'Homicides', 'Ratio'], [])
    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(TRACE_NAMES, hoverTrace)

    // Build plot data
    const { data, layout, maxRatioRow, avgRatio } = useMemo(() => {
        if (!rows.length) {
            return { data: [] as PlotData[], layout: {} as Partial<Layout>, maxRatioRow: null as CrashHomicideRow | null, avgRatio: 0 }
        }

        const years = rows.map(r => r.year)
        const trafficDeaths = rows.map(r => r.traffic_deaths)
        const homicides = rows.map(r => r.homicides)
        const ratios = rows.map(r => {
            const v = Number(r.ratio)
            return isFinite(v) ? v : 0
        })

        // Dynamic y-axis ranges
        const maxDeaths = Math.max(...trafficDeaths, ...homicides)
        const maxRatioVal = Math.max(...ratios.filter(r => isFinite(r)))
        const deathsCeil = Math.ceil(maxDeaths / 50) * 50
        const ratioCeil = Math.ceil(maxRatioVal * 5) / 5 + 0.2

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
                ...(trafficActive ? {
                    text: trafficDeaths.map(v => `<b>${v}</b>`),
                    textposition: 'outside' as const,
                    textfont: { color: '#ffffff', size: 14 },
                    textangle: 0,
                    cliponaxis: false,
                    width: 0.35,
                    zorder: 100,
                } : activeTrace !== null ? {
                    zorder: 1,
                } : {}),
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
                ...(homicidesActive ? {
                    text: homicides.map(v => `<b>${v}</b>`),
                    textposition: 'outside' as const,
                    textfont: { color: '#ffffff', size: 14 },
                    textangle: 0,
                    cliponaxis: false,
                    width: 0.35,
                    zorder: 100,
                } : activeTrace !== null ? {
                    zorder: 1,
                } : {}),
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
                    color: ratioGreyed ? fadeColor(plotColors.textColor, { opacity: 0.25 }) : plotColors.textColor,
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
                range: [0, deathsCeil],
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
                range: [0, ratioCeil],
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

        // Compute stats for caption
        const validRatios = rows
            .map(r => ({ ...r, ratio: Number(r.ratio) }))
            .filter(r => isFinite(r.ratio))
        const maxRatioRow = validRatios.length ? validRatios.reduce((a, b) => (b.ratio > a.ratio ? b : a), validRatios[0]) : null
        const avgRatio = validRatios.length
            ? validRatios.reduce((s, r) => s + r.ratio, 0) / validRatios.length
            : 0

        return { data: traces, layout, maxRatioRow, avgRatio }
    }, [rows, activeTrace, plotColors])


    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    const region = county ? `${county} County` : 'NJ'
    const minYear = rows.length ? rows[0].year : 2008
    const maxYear = rows.length ? rows[rows.length - 1].year : 2024
    const sourceLabel = effectiveSource === 'njsp' ? 'NJSP' : 'NJ DOT'

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Traffic Deaths vs. Homicides</a></h2>
            <div className={css.subtitle}>{sourceLabel} fatalities, {minYear}–{maxYear}{county ? ` · ${county} County` : ''}</div>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}

                onLegendClick={onLegendClick}
                onLegendDoubleClick={onLegendDoubleClick}
                onHoverTrace={setHoverTrace}
                onResetSolo={resetSolo}
            />
            <div className={css.plotToolbarCompact} style={{ justifyContent: 'center' }}>
                <PlotInfo source={SOURCES} />
                {!county && (
                    <div className={css.buttonBar}>
                        {([['njsp', 'NJSP (2008–)'], ['njdot', 'DOT (2001–)']] as const).map(([src, label]) => (
                            <button
                                key={src}
                                className={crashSource === src ? css.active : ''}
                                onClick={() => setCrashSource(src)}
                            >{label}</button>
                        ))}
                    </div>
                )}
            </div>
            {maxRatioRow && (
                <p className={css.plotStats}>
                    {avgRatio >= 1
                        ? <>Car crashes killed an average of {avgRatio.toFixed(1)}x as many people as homicides in {region}. In {maxRatioRow.year}, crashes killed {Number(maxRatioRow.ratio).toFixed(1)}x as many.</>
                        : <>In {region}, {avgRatio < 1 ? 'homicides outnumbered' : 'crashes matched'} traffic deaths on average ({avgRatio.toFixed(2)}x ratio).</>
                    }
                </p>
            )}
        </div>
    )
}
