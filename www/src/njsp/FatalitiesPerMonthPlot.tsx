import React, { useMemo } from "react"
import { Layout, PlotData } from "plotly.js"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { NjspSource } from "@/src/icons"
import { usePlotState, getBaseLayout, fadeColor } from "./usePlotState"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
}

export function FatalitiesPerMonthPlot({ id = "per-month" }: Props) {
    const { params, activeTrace, plotColors, legendHandlers } = usePlotState("fatalities_per_month.json")

    // Process data with styling
    const { data, layout } = useMemo(() => {
        if (!params) return { data: [], layout: {} as Partial<Layout> }

        const processedData = params.data.map(trace => {
            const newTrace = { ...trace }
            const name = String(trace.name || '')
            const isActive = activeTrace === name
            const isGreyed = activeTrace !== null && !isActive

            // Style bar traces
            if (trace.type === 'bar' && trace.marker) {
                const markerColor = typeof trace.marker.color === 'string' ? trace.marker.color : undefined
                newTrace.marker = {
                    ...trace.marker,
                    color: isGreyed ? fadeColor(markerColor) : trace.marker.color,
                    line: { color: 'transparent', width: 0 },
                }
            }

            // Style line traces (12mo avg) - white for dark mode visibility
            if ((trace.type === 'scatter' || trace.type === 'scattergl') && trace.line) {
                newTrace.line = {
                    ...trace.line,
                    color: isGreyed ? fadeColor(undefined) : '#ffffff',
                    width: isActive ? 4 : (isGreyed ? 1 : (trace.line.width ?? 2)),
                }
            }

            return newTrace
        })

        // Exclude title, template from rest
        const { xaxis, yaxis, legend, title, template, ...rest } = params.layout

        const newLayout: Partial<Layout> = {
            ...rest,
            ...getBaseLayout(plotColors, HEIGHT),
            margin: { t: 0, b: 40, l: 0, r: 0 },
            xaxis: {
                ...xaxis,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                automargin: true,
                tickangle: -45,
                tickformat: "'%y",
                hoverformat: "%b '%y",
            },
            yaxis: {
                ...yaxis,
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
            },
            legend: {
                ...legend,
                font: { color: plotColors.textColor },
                orientation: 'h',
                x: 0.5,
                xanchor: 'center',
                y: -0.08,
                yanchor: 'top',
            },
        }

        return { data: processedData, layout: newLayout }
    }, [params, activeTrace, plotColors])

    if (!data.length) {
        return <div style={{ height: HEIGHT }}>Loading...</div>
    }

    return (
        <div>
            <h2 id={id}><a href={`#${id}`}>Fatalities per Month</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/fatalities_per_month.png"
                {...legendHandlers}
            />
            <div className={css.plotNotes}>
                <p>Hover legend labels to preview; click to lock.</p>
                <NjspSource />
            </div>
        </div>
    )
}
