import React, { useMemo } from "react"
import { Layout, PlotData } from "plotly.js"
import PlotWrapper from "@/src/lib/plot-wrapper"
import A from "@/src/lib/a"
import { usePlotState, getBaseLayout, fadeColor } from "./usePlotState"
import css from "./plot.module.scss"

const HEIGHT = 450

export type Props = {
    id?: string
}

export function HomicidesComparisonPlot({ id = "vs-homicides" }: Props) {
    const { params, activeTrace, plotColors, legendHandlers } = usePlotState("crash_homicide_cmp.json")

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
                newTrace.marker = {
                    ...trace.marker,
                    color: isGreyed ? fadeColor(undefined) : trace.marker.color,
                }
            }

            // Style line traces
            if ((trace.type === 'scatter' || trace.type === 'scattergl') && trace.line) {
                newTrace.line = {
                    ...trace.line,
                    color: isGreyed ? fadeColor(undefined) : trace.line.color,
                    width: isActive ? 4 : (isGreyed ? 1 : (trace.line.width ?? 2)),
                }
            }

            return newTrace
        })

        // Exclude title, template from rest
        const { xaxis, yaxis, yaxis2, legend, title, template, ...rest } = params.layout

        // Check if x-axis has year values (for 'yy formatting)
        const tickvals = xaxis?.tickvals as number[] | undefined
        const isYearAxis = tickvals?.length && tickvals.every(v => typeof v === 'number' && v >= 2000 && v <= 2099)

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
                // Format years as 'yy to save space
                ...(isYearAxis ? {
                    ticktext: tickvals!.map(y => `'${String(y).slice(2)}`),
                } : {}),
            },
            yaxis: {
                ...yaxis,
                automargin: true,
                tickfont: { color: plotColors.textColor },
                gridcolor: plotColors.gridColor,
                title: yaxis?.title ? {
                    text: typeof yaxis.title === 'string' ? yaxis.title : yaxis.title?.text,
                    font: { color: plotColors.textColor },
                    standoff: 10,
                } : undefined,
            },
            ...(yaxis2 ? {
                yaxis2: {
                    ...yaxis2,
                    automargin: true,
                    tickfont: { color: plotColors.textColor },
                    gridcolor: plotColors.gridColor,
                    title: yaxis2?.title ? {
                        text: typeof yaxis2.title === 'string' ? yaxis2.title : yaxis2.title?.text,
                        font: { color: plotColors.textColor },
                        standoff: 5,
                    } : undefined,
                },
            } : {}),
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
            <h2 id={id}><a href={`#${id}`}>NJ Traffic Deaths vs. Homicides</a></h2>
            <PlotWrapper
                id={id}
                data={data}
                layout={layout}
                src="plots/crash_homicide_cmp.png"
                {...legendHandlers}
            />
            <div className={css.plotNotes}>
                <p>Hover legend labels to preview; click to lock.</p>
                <p>Car crashes kill twice as many people as homicides, in NJ.</p>
                <p>In 2022, crashes killed 2.4x as many people, the largest disparity on record.</p>
                <p>Homicide data comes from <A href="https://nj.gov/njsp/ucr/uniform-crime-reports.shtml">NJ State Police</A> and <A href="https://www.disastercenter.com/crime/njcrimn.htm">Disaster Center</A>.</p>
            </div>
        </div>
    )
}
