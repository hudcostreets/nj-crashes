/** Road page's over-time plots: crashes by severity (per year, or per month with a 12-month
 *  average), and killed / injured per year. Same Plotly wrapper + palette as `CrashPlot`. Data
 *  notes' years are shaded, lettered like the notes list, and named in the hover. */
import { useMemo, useState } from "react"
import type { Annotations, Layout, PlotData, Shape } from "plotly.js"
import { useTheme } from "pltly"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { EndYear, StartYear } from "@/src/constants"
import { Radios } from "@/src/njdot/Radios"
import { Severities, SeverityColorsDark, SeverityColorsLight, SeverityLabels } from "@/src/njdot/data"
import { noteBands, type NoteBand, type ScopeNote } from "./roadNotes"
import { noteColors } from "./DataNotes"
import type { RoadSummaryRow } from "./roadsData"
import { monthStats, rollingMean, yearStats } from "./roadStats"

const HEIGHT = 360

type Granularity = "year" | "month"

/** A band's x-extent: per year, bars are centered on the year; per month (a date axis), on each
 *  month's first day. */
function bandX(b: NoteBand, gran: Granularity): [number | string, number | string] {
    return gran === "year" ? [b.lo - 0.5, b.hi + 0.5] : [`${b.lo - 1}-12-16`, `${b.hi}-12-16`]
}

/** Shaded bands + letters (in the top margin) for `bands`, and an invisible trace per band whose
 *  points (one per period in it) add "A · <title>" to the unified hover. */
function bandLayers(bands: NoteBand[], gran: Granularity, fill: string, textColor: string) {
    const shapes: Partial<Shape>[] = bands.map(b => {
        const [x0, x1] = bandX(b, gran)
        return { type: "rect", xref: "x", yref: "paper", x0, x1, y0: 0, y1: 1, fillcolor: fill, line: { width: 0 }, layer: "below" }
    })
    const annotations: Partial<Annotations>[] = bands.map(b => ({
        xref: "x", yref: "paper", x: bandX(b, gran)[0], y: 1, xanchor: "left", yanchor: "bottom",
        text: `<b>${b.label}</b>`, showarrow: false, font: { size: 11, color: textColor },
    }))
    const traces: Partial<PlotData>[] = bands.map(b => {
        const x: (number | string)[] = []
        for (let y = b.lo; y <= b.hi; y++) {
            if (gran === "year") x.push(y)
            else for (let m = 1; m <= 12; m++) x.push(`${y}-${String(m).padStart(2, "0")}`)
        }
        return {
            uid: `note-${gran}-${b.id}`,
            type: "scatter",
            mode: "markers",
            name: `Note ${b.label}`,
            showlegend: false,
            x,
            y: x.map(() => 0),
            marker: { size: 1, opacity: 0 },
            hovertemplate: `<b>${b.label}</b> · ${b.title.replace(/</g, "&lt;")} (see Data notes)<extra></extra>`,
        }
    })
    return { shapes, annotations, traces }
}

/** `rows`: the road's `road-summary-monthly` rows; `notes`: its data notes (a few get bands). */
export function RoadPlots({ rows, notes = [] }: { rows: (RoadSummaryRow & { month: number })[]; notes?: ScopeNote[] }) {
    const { isDark } = useTheme()
    const colors = usePlotColors()
    const sevColors = isDark ? SeverityColorsDark : SeverityColorsLight
    const [gran, setGran] = useState<Granularity>("year")
    const years = useMemo(() => yearStats(rows, StartYear, EndYear), [rows])
    const months = useMemo(() => (gran === "month" ? monthStats(rows, StartYear, EndYear) : null), [rows, gran])

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

    const bands = useMemo(
        () => (years.years.length ? noteBands(notes, years.years[0], years.years[years.years.length - 1]) : []),
        [notes, years],
    )
    const bandFill = noteColors(isDark ? "dark" : "light").band
    const yearBands = useMemo(() => bandLayers(bands, "year", bandFill, colors.textColor), [bands, bandFill, colors])

    const hasUnplaced = useMemo(() => Severities.some(s => years.unplaced[s].some(v => v > 0)), [years])

    const sevPlot = useMemo(() => {
        const x = gran === "year" ? years.years : months!.months
        const src = gran === "year" ? years : months!
        // Each severity's crashes located by street name / route only (no map point) stack on top of
        // its placed ones, faded and hatched; the hover line gives the severity's total.
        const traces: Partial<PlotData>[] = Severities.flatMap(s => {
            const tot = src[s], un = src.unplaced[s]
            const placed: Partial<PlotData> = {
                uid: `${gran}-${s}`,
                type: "bar",
                name: SeverityLabels[s],
                legendgroup: s,
                x,
                y: hasUnplaced ? tot.map((v, k) => v - un[k]) : tot,
                text: tot.map((v, k) => `${SeverityLabels[s]}: ${v.toLocaleString()}${un[k] ? ` (${un[k].toLocaleString()} no map point)` : ""}`),
                textposition: "none",
                marker: { color: sevColors[s] },
                hovertemplate: "%{text}<extra></extra>",
            }
            if (!hasUnplaced) return [placed]
            const unplaced: Partial<PlotData> = {
                uid: `${gran}-${s}-unplaced`,
                type: "bar",
                name: `${SeverityLabels[s]} (no map point)`,
                legendgroup: s,
                showlegend: false,
                x,
                y: un,
                marker: { color: sevColors[s], opacity: 0.4, pattern: { shape: "/", fgcolor: sevColors[s], solidity: 0.35 } },
                hoverinfo: "skip",
            }
            return [placed, unplaced]
        })
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
        const nb = gran === "year" ? yearBands : bandLayers(bands, "month", bandFill, colors.textColor)
        traces.push(...nb.traces)
        const layout: Partial<Layout> = {
            ...baseLayout,
            barmode: "stack",
            xaxis: { ...baseLayout.xaxis, ...(gran === "year" ? yearTicks : {}) },
            yaxis: { ...baseLayout.yaxis, title: { text: "Crashes", font: { color: colors.textColor } } },
            shapes: nb.shapes,
            annotations: nb.annotations,
            datarevision: `${gran}-${bands.map(b => b.id).join(",")}`,
        }
        return { traces, layout }
    }, [gran, years, months, sevColors, colors, baseLayout, yearTicks, hasUnplaced, bands, bandFill, yearBands])

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
            ...yearBands.traces,
        ]
        const maxKilled = Math.max(1, ...years.killed)
        const layout: Partial<Layout> = {
            ...baseLayout,
            xaxis: { ...baseLayout.xaxis, ...yearTicks },
            yaxis: { ...baseLayout.yaxis, title: { text: "Injured", font: { color: sevColors.i } } },
            shapes: yearBands.shapes,
            annotations: yearBands.annotations,
            datarevision: bands.map(b => b.id).join(","),
            yaxis2: {
                overlaying: "y", side: "right", fixedrange: true, showgrid: false, rangemode: "tozero",
                // Integer ticks: most roads have a handful of deaths.
                range: [0, maxKilled * 1.15], dtick: maxKilled <= 5 ? 1 : undefined,
                tickfont: { color: colors.textColor },
                title: { text: "Killed", font: { color: sevColors.f } },
            },
        }
        return { traces, layout }
    }, [years, sevColors, colors, baseLayout, yearTicks, yearBands, bands])

    return (
        <div>
            <h3 style={{ marginBottom: 0 }}>Crashes by severity</h3>
            <PlotWrapper data={sevPlot.traces as PlotData[]} layout={sevPlot.layout} disableFade disableSolo boldWeight="normal" fallback={<div style={{ height: HEIGHT }} />} />
            {hasUnplaced && (
                <p style={{ margin: "0 0 0.5em", fontSize: "0.85em", opacity: 0.75 }}>
                    Faded, hatched: crashes located by street name or route only (no map point).
                </p>
            )}
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
