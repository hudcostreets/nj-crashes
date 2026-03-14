import React, { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { CrashHomicideCsv } from "@/src/paths"
import { fadeColor, useSoloTrace } from "pltly"
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
    const [avgYears, setAvgYears] = useSessionStorage<number>('homicides-avg-years', 5)
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
        const trafficActive = activeTrace === 'Traffic deaths'
        const homicidesActive = activeTrace === 'Homicides'
        const ratioActive = activeTrace === 'Ratio'
        const trafficGreyed = activeTrace !== null && !trafficActive
        const homicidesGreyed = activeTrace !== null && !homicidesActive
        const ratioGreyed = activeTrace !== null && !ratioActive

        // Helper to build bar trace with active/greyed states
        const barTrace = (
            name: string, ys: number[], color: string,
            isActive: boolean, isGreyed: boolean, hoverLabel: string,
        ): PlotData => ({
            type: "bar",
            name,
            x: years,
            y: ys,
            marker: { color: isGreyed ? fadeColor(color) : color },
            hovertemplate: `%{y} ${hoverLabel}<extra></extra>`,
            text: isActive ? ys.map(String) : undefined,
            textposition: isActive ? 'outside' : undefined,
            textfont: isActive ? { color: '#ffffff', size: 11 } : undefined,
            textangle: 0,
            cliponaxis: false,
            constraintext: 'none',
            width: isActive ? 0.6 : undefined,
            zorder: isActive ? 100 : (isGreyed ? 1 : undefined),
        } as any as PlotData)

        const traces: PlotData[] = [
            barTrace('Traffic deaths', trafficDeaths, TRAFFIC_COLOR, trafficActive, trafficGreyed, 'traffic deaths'),
            barTrace('Homicides', homicides, HOMICIDE_COLOR, homicidesActive, homicidesGreyed, 'homicides'),
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
            {highlightRow && (
                <p className={css.plotStats}>
                    Over the last{' '}
                    <select
                        value={avgYears}
                        onChange={e => setAvgYears(parseInt(e.target.value))}
                        style={{ background: 'transparent', color: 'inherit', border: 'none', borderBottom: '1px dashed currentColor', fontSize: 'inherit', fontFamily: 'inherit', cursor: 'pointer', padding: 0 }}
                    >
                        {[3, 5, 10, 15].filter(n => n <= rows.length).map(n => (
                            <option key={n} value={n}>{n} years</option>
                        ))}
                        <option value={rows.length}>all ({rows.length} years)</option>
                    </select>
                    {avgRatio >= 1
                        ? <>, car crashes killed an average of {avgRatio.toFixed(1)}x as many people as homicides in {region}. In {highlightRow.year}, crashes killed {highlightRow.ratio.toFixed(1)}x as many.</>
                        : <>, homicides outnumbered traffic deaths by {Math.round((1 / avgRatio - 1) * 100)}% on average in {region}. In {highlightRow.year}, the ratio was {highlightRow.ratio.toFixed(2)}x.</>
                    }
                </p>
            )}
        </div>
    )
}
