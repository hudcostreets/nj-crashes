import React, { useEffect, useMemo, useRef, useState } from "react"
import { useResetSolo } from "@/src/lib/ResetSoloContext"
import type { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredParquetDb } from "@/src/tableData"
import { CrashHomicideParquet, YtcParquet } from "@/src/paths"
import { VICTIM_LABEL_SINGULAR, VICTIM_TYPES, type VictimType } from "./victim-types"
import { useAlignedDualAxes, LegendRow, LegendItem, useLegendPin } from "pltly/react"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo, DataSource } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "@/src/lib/useSessionStorage"
import { useAnnotations } from "@/src/annotations/useAnnotations"
import { toPlotLayers } from "@/src/annotations/plot"
import { AnnotationTrigger, AnnotationBody, useAnnotationOpenState } from "@/src/annotations/AnnotationDetails"
import { usePageFilters } from "@/src/PageFiltersContext"
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

// Legend item keys — also the plot trace names, so `legend.activeItem`
// matches a trace `name` directly.
const LEGEND_ITEMS = ['Car crash deaths', 'Homicides', 'Ratio'] as const
type LegendKey = typeof LEGEND_ITEMS[number]

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

// Per-year, per-victim-type NJSP fatal counts. Used to override the
// pre-aggregated `traffic_deaths` column from `crash_homicide.parquet`
// when the page-level victim-type filter is active.
type YtcRow = {
    year: number
    driver: number
    passenger: number
    pedestrian: number
    cyclist: number
}

// Query to get crash-homicide data (filtered by county and source)
const crashHomicideQueryFn = (county: string | null, source: CrashSource) => `
    SELECT year, traffic_deaths, homicides, ratio
    FROM read_parquet('crash_homicide')
    WHERE source = '${source}'
      AND (${county ? `county = '${county}'` : `county IS NULL OR county = ''`})
    ORDER BY year
`

const ytcTypeQueryFn = (county: string | null) => `
    SELECT
        year,
        CAST(sum(driver) as INT) as driver,
        CAST(sum(passenger) as INT) as passenger,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist
    FROM read_parquet('ytc')
    ${county ? `WHERE county = '${county}'` : ``}
    GROUP BY year
    ORDER BY year
`

export function HomicidesComparisonPlot({ id = "vs-homicides", county, cc = null, height: propHeight, width: propWidth }: Props) {
    const plotHeight = propHeight ?? HEIGHT
    // Note: crash-homicide data only exists at statewide and county level (no muni breakdowns)
    const db = useDb()
    const plotColors = usePlotColors()
    const plotAnnotations = useAnnotations({ page: 'homicides-comparison', cc, mc: null })
    const annOpen = useAnnotationOpenState()

    const [avgYears, setAvgYears] = useSessionStorage<number>('homicides-avg-years', 5)
    // Page-level victim-type filter (NJSP-only — NJDOT doesn't share our
    // categorization). When the user narrows via `nst`, force the crash
    // source to NJSP so the plot compares filtered NJSP fatalities vs.
    // homicides.
    const filters = usePageFilters()
    const selectedTypes: VictimType[] = filters?.selectedTypes ?? VICTIM_TYPES
    const typesActive = !!filters?.typesActive
    // Only show source toggle for statewide (county data is NJSP-only)
    const [crashSource] = useSessionStorage<CrashSource>('homicides-crash-source', 'njsp')
    // Force NJSP for county views AND when a type filter is active.
    const effectiveSource: CrashSource = (county || typesActive) ? 'njsp' : crashSource

    // Load crash-homicide data
    const crashHomicideDb = useRegisteredParquetDb({ db, table: "crash_homicide", url: CrashHomicideParquet })
    const crashHomicideQuery = useMemo(() => crashHomicideQueryFn(county ?? null, effectiveSource), [county, effectiveSource])
    const rowsRaw = useQuery<CrashHomicideRow>({ db: crashHomicideDb, query: crashHomicideQuery, init: [] })

    // Per-victim-type NJSP counts — used to derive filtered `traffic_deaths`
    // when the type filter is active. Loaded unconditionally so toggling
    // the filter doesn't trigger a fetch.
    const ytcDb = useRegisteredParquetDb({ db, table: "ytc", url: YtcParquet })
    const ytcQuery = useMemo(() => ytcTypeQueryFn(county ?? null), [county])
    const ytcRows = useQuery<YtcRow>({ db: ytcDb, query: ytcQuery, init: [] })

    // Override `traffic_deaths` with the sum of selected type columns when
    // the type filter narrows below all four. Homicides + ratio are
    // recomputed against the filtered traffic total. Years where the type
    // breakdown is missing (e.g. pre-2020 statewide) come through as 0 —
    // acceptable, mirrors what the NJSP plot above shows for the same
    // year+filter combo.
    const rowsAll = useMemo<CrashHomicideRow[]>(() => {
        if (!typesActive) return rowsRaw
        const ytcByYear = new Map(ytcRows.map(r => [r.year, r]))
        return rowsRaw.map(r => {
            const y = ytcByYear.get(r.year)
            let filtered = 0
            if (y) {
                for (const t of selectedTypes) filtered += (y as unknown as Record<VictimType, number>)[t] ?? 0
            }
            const ratio = r.homicides > 0 ? filtered / r.homicides : null
            return { year: r.year, traffic_deaths: filtered, homicides: r.homicides, ratio }
        })
    }, [rowsRaw, ytcRows, typesActive, selectedTypes])

    // Section-scoped year-range filter (PageFilters).
    const yearRange = filters?.yearRangeActive ? filters.yearRange : null
    const rows = useMemo(
        () => yearRange ? rowsAll.filter(r => r.year >= yearRange[0] && r.year <= yearRange[1]) : rowsAll,
        [rowsAll, yearRange],
    )

    // Pin/hover state for the custom legend (`pltly`'s `useLegendPin`),
    // matching `FatalitiesPerYearPlot`.
    const legend = useLegendPin<LegendKey>(LEGEND_ITEMS)
    useResetSolo(legend.clear)

    const containerRef = useRef<HTMLDivElement>(null)
    const [containerWidth, setContainerWidth] = useState(800)
    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const update = () => setContainerWidth(el.clientWidth)
        update()
        const obs = new ResizeObserver(update)
        obs.observe(el)
        return () => obs.disconnect()
    }, [])

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
        const isActive = (name: string) => legend.activeItem === name

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
            showlegend: false,
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

        // Inject annotation shapes/icons (e.g. shaded year ranges for known data issues)
        const { shapes: annShapes, annotations: annTextEls } = toPlotLayers(plotAnnotations)
        if (annShapes.length) {
            layout.shapes = [...(layout.shapes || []), ...annShapes]
        }
        if (annTextEls.length) {
            layout.annotations = [...(layout.annotations || []), ...annTextEls]
        }

        return { data: traces, layout, highlightRow, avgRatio }
    }, [rows, legend.activeItem, plotColors, axisAlignment, avgYears, plotAnnotations])


    if (!data.length) {
        return <div style={{ height: plotHeight }}>Loading...</div>
    }

    const region = county ? `${county} County` : 'NJ'
    const minYear = rows.length ? rows[0].year : 2001
    const maxYear = rows.length ? rows[rows.length - 1].year : 2024
    const sourceLabel = effectiveSource === 'njsp' ? 'NJSP' : 'NJ DOT'
    // Pluralized victim-type phrase for the caption: "pedestrian",
    // "pedestrian/cyclist", "pedestrian, driver/cyclist", etc. Preserve
    // canonical order (driver, passenger, pedestrian, cyclist).
    const typeLabels = VICTIM_TYPES.filter(t => selectedTypes.includes(t)).map(t => VICTIM_LABEL_SINGULAR[t])
    const typePhrase = typesActive ? typeLabels.join("/") : null
    // Plural noun (`pedestrians`) for use as the direct object of
    // "crashes killed X ___". When multiple types are selected, we bail
    // back to the generic "people" phrasing rather than stitch together
    // an awkward "pedestrians/cyclists" phrase.
    const filteredNoun = typesActive && typeLabels.length === 1 ? `${typeLabels[0]}s` : 'people'

    return (
        <div ref={containerRef}>
            <h2 id={id}><a href={`#${id}`}>Car Crash Deaths vs. Homicides</a></h2>
            <div className={css.subtitle}>
                {sourceLabel} {typePhrase ? `${typePhrase} ` : ''}fatalities, {minYear}–{maxYear}{county ? ` · ${county} County` : ''}
            </div>
            <PlotWrapper
                key={rows.length}
                id={id}
                data={data}
                layout={layout}
                onResetSolo={legend.clear}
                onClickAnnotation={() => annOpen.setPinned(!annOpen.pinned)}
                onHoverAnnotation={() => annOpen.setHovered(true)}
                onUnhoverAnnotation={() => annOpen.setHovered(false)}
                fadeInactiveAxis
            />
            <LegendRow
                width={containerWidth}
                left={<>
                    <PlotInfo source={SOURCES} showLegendHint={false} />
                    <AnnotationTrigger annotations={plotAnnotations} state={annOpen} />
                </>}
                center={<>
                    <LegendItem color={TRAFFIC_COLOR} label="Car crash deaths" {...legend.getItemProps('Car crash deaths')} />
                    <LegendItem color={HOMICIDE_COLOR} label="Homicides" {...legend.getItemProps('Homicides')} />
                    <LegendItem type="line" color="#fff" label="Ratio" {...legend.getItemProps('Ratio')} />
                </>}
            />
            <AnnotationBody annotations={plotAnnotations} state={annOpen} />
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
                        // With a type filter active most ratios fall below 1
                        // (e.g. pedestrian deaths vs. all homicides), so we
                        // switch the sub-1x phrasing from "N% fewer" to
                        // "N% as many" — the latter reads more naturally
                        // when the filtered noun differs from the compare
                        // set. Bold segment / trailing segment.
                        const fmtRatio = (r: number): [string, string] => {
                            if (r >= 1.8) return [`${r.toFixed(1)}x as many`, `${filteredNoun} as`]
                            if (r >= 1) return [`${Math.round((r - 1) * 100)}% more`, `${filteredNoun} than`]
                            return [`${Math.round(r * 100)}% as many`, `${filteredNoun} as`]
                        }
                        const [avgBold, avgRest] = fmtRatio(avgRatio)
                        const [hlBold, hlRest] = fmtRatio(highlightRow.ratio)
                        // When a type filter is active we compare filtered
                        // crash deaths against ALL homicides — say so
                        // explicitly, else the phrasing implies pedestrians
                        // (etc.) killed by homicides.
                        const homNoun = typesActive ? 'all homicides' : 'homicides'
                        return <>
                            , car crashes killed <b>{avgBold}</b> {avgRest} {homNoun} in {region}.
                            <br />In {highlightRow.year}, crashes killed <b>{hlBold}</b> {hlRest} {homNoun}.
                        </>
                    })()}
                </p>
            )}
        </div>
    )
}
