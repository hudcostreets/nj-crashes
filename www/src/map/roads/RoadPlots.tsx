/** Road page's over-time plots: crashes by severity (per year, or per month with a 12-month
 *  average), and killed / injured per year. Same Plotly wrapper + palette as `CrashPlot`. */
import { useMemo, useState } from "react"
import type { Layout, PlotData } from "plotly.js"
import { useTheme } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { EndYear, StartYear } from "@/src/constants"
import { Radios } from "@/src/njdot/Radios"
import { Severities, SeverityColorsDark, SeverityColorsLight, SeverityLabels } from "@/src/njdot/data"
import type { RoadCrashView } from "./roadsData"
import { monthStats, rollingMean, yearStats } from "./roadStats"

const HEIGHT = 360

type Granularity = "year" | "month"

export function RoadPlots({ crashes }: { crashes: RoadCrashView[] }) {
    const { isDark } = useTheme()
    const colors = usePlotColors()
    const sevColors = isDark ? SeverityColorsDark : SeverityColorsLight
    const [gran, setGran] = useState<Granularity>("year")
    const years = useMemo(() => yearStats(crashes, StartYear, EndYear), [crashes])
    const months = useMemo(() => (gran === "month" ? monthStats(crashes, StartYear, EndYear) : null), [crashes, gran])

    const baseLayout = useMemo((): Partial<Layout> => ({
        height: HEIGHT,
        margin: { t: 20, b: 40, l: 50, r: 50 },
        xaxis: {
            gridcolor: colors.gridColor,
            tickfont: { color: colors.textColor },
            fixedrange: true,
        },
        yaxis: { gridcolor: colors.gridColor, tickfont: { color: colors.textColor }, fixedrange: true, rangemode: "tozero" },
        dragmode: false,
        showlegend: true,
        legend: {
            orientation: "h", traceorder: "normal", x: 0.5, xanchor: "center", y: -0.12, yanchor: "top",
            font: { color: colors.textColor },
        },
        hovermode: "x unified",
        hoverlabel: {
            bgcolor: isDark ? "rgba(20, 22, 34, 0.98)" : "rgba(252, 252, 255, 0.98)",
            bordercolor: colors.gridColor,
            font: { color: colors.textColor, size: 13, family: "system-ui, sans-serif" },
            align: "left",
        },
        paper_bgcolor: colors.paperBg,
        plot_bgcolor: colors.plotBg,
    }), [colors, isDark])

    const yearTicks = useMemo(() => ({
        dtick: 1,
        tickangle: -45,
        range: [years.years[0] - 0.5, years.years[years.years.length - 1] + 0.5],
        tickvals: years.years,
        ticktext: years.years.map(y => `'${String(y).slice(2)}`),
    }), [years])

    const sevPlot = useMemo(() => {
        const x = gran === "year" ? years.years : months!.months
        const src = gran === "year" ? years : months!
        const traces: Partial<PlotData>[] = Severities.map(s => ({
            uid: `${gran}-${s}`,
            type: "bar",
            name: SeverityLabels[s],
            x,
            y: src[s],
            marker: { color: sevColors[s] },
            hovertemplate: `${SeverityLabels[s]}: %{y:,}<extra></extra>`,
        }))
        if (gran === "month") {
            const totals = x.map((_, k) => src.f[k] + src.i[k] + src.p[k])
            traces.push({
                uid: "month-avg",
                type: "scatter",
                mode: "lines",
                name: "12-mo avg",
                x,
                y: rollingMean(totals, 12) as number[],
                line: { color: colors.textColor, width: 2.5 },
                hovertemplate: "12-mo avg: %{y:,.1f}<extra></extra>",
            })
        }
        const layout: Partial<Layout> = {
            ...baseLayout,
            barmode: "stack",
            xaxis: { ...baseLayout.xaxis, ...(gran === "year" ? yearTicks : {}) },
            yaxis: { ...baseLayout.yaxis, title: { text: "Crashes", font: { color: colors.textColor } } },
            datarevision: gran,
        }
        return { traces, layout }
    }, [gran, years, months, sevColors, colors, baseLayout, yearTicks])

    const casualtyPlot = useMemo(() => {
        const traces: Partial<PlotData>[] = [
            {
                type: "bar",
                name: "Injured",
                x: years.years,
                y: years.injured,
                marker: { color: sevColors.i },
                hovertemplate: "Injured: %{y:,}<extra></extra>",
            },
            {
                type: "scatter",
                mode: "lines+markers",
                name: "Killed",
                x: years.years,
                y: years.killed,
                yaxis: "y2",
                line: { color: sevColors.f, width: 2.5 },
                marker: { color: sevColors.f, size: 7 },
                hovertemplate: "Killed: %{y:,}<extra></extra>",
            },
        ]
        const maxKilled = Math.max(1, ...years.killed)
        const layout: Partial<Layout> = {
            ...baseLayout,
            xaxis: { ...baseLayout.xaxis, ...yearTicks },
            yaxis: { ...baseLayout.yaxis, title: { text: "Injured", font: { color: sevColors.i } } },
            yaxis2: {
                overlaying: "y", side: "right", fixedrange: true, showgrid: false, rangemode: "tozero",
                // Integer ticks: most roads have a handful of deaths.
                range: [0, maxKilled * 1.15], dtick: maxKilled <= 5 ? 1 : undefined,
                tickfont: { color: colors.textColor },
                title: { text: "Killed", font: { color: sevColors.f } },
            },
        }
        return { traces, layout }
    }, [years, sevColors, colors, baseLayout, yearTicks])

    return (
        <div>
            <h3 style={{ marginBottom: 0 }}>Crashes by severity</h3>
            <PlotWrapper data={sevPlot.traces as PlotData[]} layout={sevPlot.layout} disableFade disableSolo boldWeight="normal" fallback={<div style={{ height: HEIGHT }} />} />
            <Radios
                label="Per"
                name="road-granularity"
                options={[{ label: "Year", data: "year" }, { label: "Month", data: "month" }]}
                choice={gran}
                cb={setGran}
            />
            <h3 style={{ marginBottom: 0 }}>Killed & injured</h3>
            <PlotWrapper data={casualtyPlot.traces as PlotData[]} layout={casualtyPlot.layout} disableFade disableSolo boldWeight="normal" fallback={<div style={{ height: HEIGHT }} />} />
        </div>
    )
}
