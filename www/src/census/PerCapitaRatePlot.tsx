import { useEffect, useMemo, useRef, useState } from "react"
import { useResetSolo } from "@/src/lib/ResetSoloContext"
import type { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { MonthlyCsv } from "@/src/paths"
import { LegendRow } from "pltly/react"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { getPopulation, usePopulation } from "@/src/census/usePopulation"
import css from "@/src/njsp/plot.module.scss"

const HEIGHT = 380
const RATE_COLOR = '#cc7733'
const POP_LAST_YEAR = 2023

export type Props = {
    id?: string
    cc?: number | null
    mc?: number | null
    regionLabel?: string | null
    height?: number
}

type FatalityRow = { year: number; fatalities: number }

const fatalitiesByYearQuery = (cc: number | null, mc: number | null) => {
    const where = mc !== null
        ? `cc = ${cc} AND mc = ${mc}`
        : cc !== null
            ? `cc = ${cc} AND mc IS NULL`
            : `cc IS NULL AND mc IS NULL`
    return `
        SELECT year, CAST(SUM(fatalities) as INT) as fatalities
        FROM read_csv_auto('monthly')
        WHERE ${where}
        GROUP BY year
        ORDER BY year
    `
}

export function PerCapitaRatePlot({ id = "per-capita-rate", cc = null, mc = null, regionLabel, height = HEIGHT }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()
    const monthlyDb = useRegisteredDb({ db, table: "monthly", url: MonthlyCsv })
    const { lookup, loading: popLoading, error: popError } = usePopulation()

    const fatalitiesQuery = useMemo(() => fatalitiesByYearQuery(cc, mc), [cc, mc])
    const fatalityRows = useQuery<FatalityRow>({ db: monthlyDb, query: fatalitiesQuery, init: [] })

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

    useResetSolo(() => {})

    const { data, layout } = useMemo(() => {
        if (!lookup || !fatalityRows.length) return { data: [] as PlotData[], layout: {} as Partial<Layout> }
        const geo = { cc, mc }
        const points = fatalityRows.map(r => {
            // For years past the latest ACS5 vintage (2023), reuse 2023 pop as the denominator.
            const popYear = Math.min(r.year, POP_LAST_YEAR)
            const pop = getPopulation(lookup, geo, popYear)
            if (pop === null || pop === 0) return null
            return { year: r.year, rate: (r.fatalities * 1e5) / pop, fatalities: r.fatalities, pop, popYear }
        }).filter((p): p is NonNullable<typeof p> => p !== null)

        if (!points.length) return { data: [] as PlotData[], layout: {} as Partial<Layout> }

        const trace: Partial<PlotData> = {
            x: points.map(p => p.year),
            y: points.map(p => p.rate),
            type: 'scatter',
            mode: 'lines+markers',
            line: { color: RATE_COLOR, width: 2 },
            marker: { color: RATE_COLOR, size: 6 },
            customdata: points.map(p => [p.fatalities, p.pop, p.popYear !== p.year ? `(${p.popYear} pop)` : '']),
            hovertemplate: '<b>%{x}</b><br>%{y:.2f} per 100k<br>%{customdata[0]} fatalities<br>pop: %{customdata[1]:,} %{customdata[2]}<extra></extra>',
            name: 'rate',
            showlegend: false,
        }

        const layout: Partial<Layout> = {
            height,
            margin: { l: 60, r: 20, t: 12, b: 50 },
            xaxis: { title: { text: '' }, tickfont: { color: plotColors.text }, gridcolor: plotColors.grid, zeroline: false, color: plotColors.text },
            yaxis: { title: { text: 'fatalities per 100k', font: { color: plotColors.text } }, tickfont: { color: plotColors.text }, gridcolor: plotColors.grid, zeroline: false, rangemode: 'tozero', color: plotColors.text },
            paper_bgcolor: plotColors.paperBg,
            plot_bgcolor: plotColors.plotBg,
            hovermode: 'x unified',
        }
        return { data: [trace], layout }
    }, [fatalityRows, lookup, cc, mc, height, plotColors])

    if (popError) {
        return <div style={{ height, padding: '0.5em 0', color: plotColors.text, fontSize: 12, opacity: 0.7 }}>population data unavailable: {popError}</div>
    }
    if (popLoading) {
        return <div style={{ height }}>Loading population data...</div>
    }
    if (!data.length) {
        return <div style={{ height }}>No data for this region.</div>
    }

    return (
        <div ref={containerRef}>
            <h2 id={id}>
                <a href={`#${id}`}>Per-Capita Fatality Rate</a>
            </h2>
            <div className={css.subtitle}>
                Fatalities per 100k population, 2001–present
                {regionLabel ? ` · ${regionLabel}` : ''}
            </div>
            <PlotWrapper id={id} data={data} layout={layout} disableFade />
            <LegendRow
                width={containerWidth}
                center={<PlotInfo source="njsp" showLegendHint={false}>
                    <p style={{ margin: 0 }}>
                        Rate uses NJSP fatality counts and ACS 5-year population estimates
                        ({POP_LAST_YEAR} population is reused for {POP_LAST_YEAR + 1}+; pre-2009 interpolated from 2000 Decennial).
                    </p>
                </PlotInfo>}
            />
        </div>
    )
}
