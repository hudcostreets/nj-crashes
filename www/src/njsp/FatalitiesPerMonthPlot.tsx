import React, { useMemo, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { useDb, useQuery } from "@/src/lib/DuckDbContext"
import { useRegisteredDb } from "@/src/tableData"
import { MonthlyCsv } from "@/src/paths"
import { fadeColor, useSoloTrace } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { PlotInfo } from "@/src/icons"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
    /** When set, shows a note that this plot is statewide (no county-level monthly data) */
    county?: string | null
}

type MonthlyRow = {
    date: string
    year: number
    month: number
    fatalities: number
    avg_12mo: number
}

// Query to get monthly data (filtered by county if set)
const monthlyQueryFn = (county: string | null) => `
    SELECT date, year, month, fatalities, avg_12mo
    FROM read_csv_auto('monthly')
    WHERE ${county ? `county = '${county}'` : `county IS NULL`}
    ORDER BY date
`

// Bar color
const BAR_COLOR = '#ba3853'
// Line color (white for visibility on dark background)
const LINE_COLOR = '#ffffff'

export function FatalitiesPerMonthPlot({ id = "per-month", county }: Props) {
    const db = useDb()
    const plotColors = usePlotColors()

    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    // Load monthly data
    const monthlyDb = useRegisteredDb({ db, table: "monthly", url: MonthlyCsv })
    const monthlyQueryStr = useMemo(() => monthlyQueryFn(county ?? null), [county])
    const monthlyRows = useQuery<MonthlyRow>({ db: monthlyDb, query: monthlyQueryStr, init: [] })

    const TRACE_NAMES = useMemo(() => ['Fatalities', '12-mo avg'], [])
    const { activeTrace, onLegendClick, onLegendDoubleClick, resetSolo } = useSoloTrace(TRACE_NAMES, hoverTrace)

    // Build plot data
    const { data, layout } = useMemo(() => {
        if (!monthlyRows.length) {
            return { data: [], layout: {} as Partial<Layout> }
        }

        // Filter out incomplete current month
        const now = new Date()
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1  // 1-indexed

        const isMonthComplete = (year: number, month: number) => {
            if (year < currentYear) return true
            if (year === currentYear && month < currentMonth) return true
            return false
        }

        const filteredRows = monthlyRows.filter(r => isMonthComplete(r.year, r.month))

        const dates = filteredRows.map(r => r.date)
        const fatalities = filteredRows.map(r => r.fatalities)
        // Only show 12-mo avg after 12 months of data (first 11 values are partial averages)
        const avg12mo = filteredRows.map((r, i) => i < 11 ? null : r.avg_12mo)

        const fatalitiesActive = activeTrace === 'Fatalities'
        const avgActive = activeTrace === '12-mo avg'
        const fatalitiesGreyed = activeTrace !== null && !fatalitiesActive
        const avgGreyed = activeTrace !== null && !avgActive

        const traces: PlotData[] = [
            // Bar trace for monthly fatalities
            {
                type: "bar",
                name: "Fatalities",
                x: dates,
                y: fatalities,
                marker: {
                    color: fatalitiesGreyed ? fadeColor(BAR_COLOR) : BAR_COLOR,
                    line: { color: 'transparent', width: 0 },
                },
                hovertemplate: `%{y} deaths<extra>Fatalities</extra>`,
            } as PlotData,
            // Line trace for 12-month rolling average
            {
                type: "scatter",
                mode: "lines",
                name: "12-mo avg",
                x: dates,
                y: avg12mo,
                line: {
                    color: avgGreyed ? fadeColor(LINE_COLOR) : LINE_COLOR,
                    width: avgActive ? 6 : (avgGreyed ? 2 : 4),
                },
                hovertemplate: `%{y:.1f}<extra>12-mo avg</extra>`,
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
    }, [monthlyRows, activeTrace, plotColors])


    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Fatalities per Month{county ? `: ${county} County` : ''}</a></h2>
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
                <PlotInfo source="njsp" />
            </div>
        </div>
    )
}
