import React, { useMemo, useState } from "react"
import { useResetSolo } from "@/src/lib/ResetSoloContext"
import type { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { CrashHomicideCsv } from "@/src/paths"
import { useAlignedDualAxes } from "pltly/react"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo, DataSource } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import css from "./plot.module.scss"

const HEIGHT = 450

type CrashSource = 'njsp' | 'njdot'

// Data sources for this plot
const SOURCES: DataSource[] = [
    { label: "NJ State Police", href: "https://njsp.njoag.gov/fatal-crash-statistics/", note: "Car crash deaths" },
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
    height?: number
    width?: number
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

export function HomicidesComparisonPlot({ id = "vs-homicides", county, height: propHeight, width: propWidth }: Props) {
    const plotHeight = propHeight ?? HEIGHT
    // Note: crash-homicide data only exists at statewide and county level (no muni breakdowns)
    const db = useDb()
    const plotColors = usePlotColors()

    const [avgYears, setAvgYears] = useSessionStorage<number>('homicides-avg-years', 5)
    // Only show source toggle for statewide (county data is NJSP-only)
    const [crashSource, setCrashSource] = useSessionStorage<CrashSource>('homicides-crash-source', 'njsp')
    // Force NJSP for county views
    const effectiveSource = county ? 'njsp' as CrashSource : crashSource

    // Load crash-homicide data
    const crashHomicideDb = useRegisteredDb({ db, table: "crash_homicide", url: CrashHomicideCsv })
    const crashHomicideQuery = useMemo(() => crashHomicideQueryFn(county ?? null, effectiveSource), [county, effectiveSource])
    const rows = useQuery<CrashHomicideRow>({ db: crashHomicideDb, query: crashHomicideQuery, init: [] })

    const [activeTrace, setActiveTrace] = useState<string | null>(null)
    useResetSolo(() => setActiveTrace(null))

    // Pre-compute value arrays for dual-axis alignment hook (must be unconditional)
    const deathValues = useMemo(() => rows.flatMap(r => [r.traffic_deaths, r.homicides]), [rows])
    const ratioValues = useMemo(() => rows.map(r => Number(r.ratio)).filter(isFinite), [rows])
    const axisAlignment = useAlignedDualAxes({ values1: deathValues, values2: ratioValues })

    // Build plot data
    const { data, layout, highlightRow, avgRatio } = useMemo(() => {
        if (!rows.length) {
            return { data: [] as PlotData[], layout: {} as Partial<Layout>, highlightRow: null as (CrashHomicideRow & { ratio: number }) | null, avgRatio: 0 }
        }

        const years = rows.map(r => r.year)
        const trafficDeaths = rows.map(r => r.traffic_deaths)
        const homicides = rows.map(r => r.homicides)
        const ratios = rows.map(r => {
            const v = Number(r.ratio)
            return isFinite(v) ? v : 0
        })
        const isActive = (name: string) => activeTrace === name

        // Traces: pltly handles fade, we add extras (width, text, zorder) for active trace
        const barTrace = (
            name: string, ys: number[], color: string, hoverLabel: string,
        ): PlotData => ({
            type: "bar",
            name,
            x: years,
            y: ys,
            marker: { color },
            hovertemplate: `%{y} ${hoverLabel}<extra></extra>`,
            text: isActive(name) ? ys.map(String) : undefined,
            textposition: isActive(name) ? 'outside' : undefined,
            textfont: isActive(name) ? { color: '#ffffff', size: 11 } : undefined,
            textangle: 0,
            cliponaxis: false,
            constraintext: 'none',
            width: isActive(name) ? 0.6 : undefined,
            zorder: isActive(name) ? 100 : undefined,
        } as any as PlotData)

        const traces: PlotData[] = [
            barTrace('Car crash deaths', trafficDeaths, TRAFFIC_COLOR, 'car crash deaths'),
            barTrace('Homicides', homicides, HOMICIDE_COLOR, 'homicides'),
            // Ratio line (secondary y-axis)
            {
                type: "scatter",
                mode: "lines",
                name: "Ratio",
                x: years,
                y: ratios,
                yaxis: "y2",
                line: {
                    color: plotColors.textColor,
                    width: 5,
                },
                hovertemplate: `%{y:.2f}x<extra>Ratio</extra>`,
                zorder: isActive('Ratio') ? 100 : undefined,
            } as any as PlotData,
        ]

        const layout: Partial<Layout> = {
            showlegend: true,
            height: plotHeight,
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
                // Add 10% headroom above max bar value so outside text labels aren't cropped
                range: [0, Math.max(...trafficDeaths, ...homicides) * 1.1],
                ...axisAlignment?.yaxis,
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
                ...axisAlignment?.yaxis2,
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
                itemwidth: 15,
                textgap: 8,
                itemgap: 24,
            },
            dragmode: false,
        }

        // Compute stats for caption (using configurable window)
        const validRatios = rows
            .map(r => ({ ...r, ratio: Number(r.ratio) }))
            .filter(r => isFinite(r.ratio))
        const recentN = validRatios.slice(-avgYears)
        const avgRatio = recentN.length
            ? recentN.reduce((s, r) => s + r.ratio, 0) / recentN.length
            : 0

        // Pick a notable year: highest in the window, or most recent if close
        const latestYear = recentN.length ? recentN[recentN.length - 1] : null
        const recentMax = recentN.length ? recentN.reduce((a, b) => b.ratio > a.ratio ? b : a) : null
        const highlightRow = (recentMax && latestYear && recentMax.ratio > latestYear.ratio * 1.2)
            ? recentMax
            : latestYear

        return { data: traces, layout, highlightRow, avgRatio }
    }, [rows, activeTrace, plotColors, axisAlignment, avgYears])


    if (!data.length) {
        return <div style={{ height: plotHeight }}>Loading...</div>
    }

    const region = county ? `${county} County` : 'NJ'
    const minYear = rows.length ? rows[0].year : 2008
    const maxYear = rows.length ? rows[rows.length - 1].year : 2024
    const sourceLabel = effectiveSource === 'njsp' ? 'NJSP' : 'NJ DOT'

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Car Crash Deaths vs. Homicides</a></h2>
            <div className={css.subtitle}>{sourceLabel} fatalities, {minYear}–{maxYear}{county ? ` · ${county} County` : ''}</div>
            <PlotWrapper
                key={rows.length}
                id={id}
                data={data}
                layout={layout}
                onActiveTrace={setActiveTrace}
                fadeInactiveAxis
            />
            <div className={css.plotToolbarCompact} style={{ justifyContent: 'center' }}>
                <PlotInfo source={SOURCES} />
                {!county && (
                    <div className={css.buttonBar}>
                        <button
                            className={crashSource === 'njsp' ? css.active : ''}
                            onClick={() => setCrashSource('njsp')}
                        >NJSP ('08–'24)</button>
                        <button
                            className={crashSource === 'njdot' ? css.active : ''}
                            onClick={() => setCrashSource('njdot')}
                        >DOT ('01–'23)</button>
                    </div>
                )}
            </div>
            {highlightRow && (
                <p className={css.plotStats}>
                    Over the last{' '}
                    <select
                        value={avgYears}
                        onChange={e => setAvgYears(parseInt(e.target.value))}
                        style={{ background: 'transparent', color: 'inherit', border: 'none', borderBottom: '1px dotted currentColor', fontSize: '1.1em', fontWeight: 'bold', fontFamily: 'inherit', cursor: 'pointer', padding: 0, width: `${String(avgYears).length + 0.5}ch`, appearance: 'none', WebkitAppearance: 'none', textAlign: 'center' }}
                    >
                        {[3, 5, 10, 15].filter(n => n <= rows.length).map(n => (
                            <option key={n} value={n}>{n}</option>
                        ))}
                    </select>
                    {' '}years
                    {(() => {
                        const fmtRatio = (r: number): [string, string] => {
                            if (r >= 1.8) return [`${r.toFixed(1)}x as many`, 'people as']
                            if (r >= 1) return [`${Math.round((r - 1) * 100)}% more`, 'people than']
                            return [`${Math.round((1 - r) * 100)}% fewer`, 'people than']
                        }
                        const [avgBold, avgRest] = fmtRatio(avgRatio)
                        const [hlBold, hlRest] = fmtRatio(highlightRow.ratio)
                        return <>
                            , car crashes killed <b>{avgBold}</b> {avgRest} homicides in {region}.
                            <br />In {highlightRow.year}, crashes killed <b>{hlBold}</b> {hlRest} homicides.
                        </>
                    })()}
                </p>
            )}
        </div>
    )
}
