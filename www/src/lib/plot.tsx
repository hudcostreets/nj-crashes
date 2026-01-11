// Vite replacement for @rdub/next-plotly/plot
// Simplified version that loads plot data client-side

import React, { CSSProperties, ReactNode, useEffect, useMemo, useState } from "react"
import { PlotParams } from "react-plotly.js"
import { Datum, Layout, Legend, Margin, PlotData } from "plotly.js"
import { fromEntries, o2a } from "@rdub/base/objs"
import PlotWrapper from "./plot-wrapper"
import { usePlotColors } from "@/src/hooks/usePlotColors"
import { useSessionStorage } from "./useSessionStorage"
import { COLORSCALES, ColorScaleName, getColorAt } from "./colorscales"

export const DEFAULT_HEIGHT = 450
export const DEFAULT_MARGIN: Partial<Margin> = { t: 20, b: 40, l: 0, r: 0 }

export type PlotsDict<Params extends PlotParams = PlotParams> = { [id: string]: Params }

export type XRange = [number, number]
export type FilterArgs = {
    data: PlotData[]
    xRange: XRange
}
export type Filter = (_: FilterArgs) => PlotData[]

export const filterIdxs: Filter = ({ data, xRange }: FilterArgs) => {
    const xs = Math.round(xRange[0])
    const xe = Math.round(xRange[1])
    return data.map(
        ({ x, y, ...trace }) => ({
            x: (x as Datum[]).slice(xs, xe),
            y: (y as Datum[]).slice(xs, xe),
            ...trace,
        })
    )
}

export type FilterValuesArgs = {
    keepNull?: boolean
    mapRange?: (xRange: XRange) => XRange
}
export const filterValues: ({ keepNull, mapRange }: FilterValuesArgs) => Filter =
    ({ keepNull, mapRange }) =>
        ({ data, xRange }) => {
            keepNull = keepNull || keepNull === undefined
            const [xs, xe] = mapRange ? mapRange(xRange) : xRange
            return data.map(
                ({ x, y, ...trace }) => {
                    const yArr = y as Datum[]
                    const enumerated =
                        (x as number[])
                            .map((v, idx) => [v, idx] as const)
                            .filter(([v]) => (v === null ? keepNull : (xs <= v && v <= xe)))
                    const idxs = enumerated.map(([, idx]) => idx)
                    return {
                        x: enumerated.map(([v]) => v),
                        y: yArr.filter((_, idx) => idxs.includes(idx)),
                        ...trace,
                    }
                }
            )
        }

export const HalfRoundWiden: (xRange: XRange) => XRange = ([xs, xe]) => {
    xs = Math.round(xs - 0.5) + 0.5
    xe = Math.round(xe + 0.5) - 0.5
    return [xs, xe]
}

export type PlotSpec = {
    id: string
    name?: string
    menuName?: string
    dropdownSection?: string
    title?: string
    subtitle?: ReactNode
    width?: number
    height?: number
    style?: CSSProperties
    legend?: "inherit" | Legend
    src?: string
    filter?: Filter
    children?: ReactNode
    // Optional legend interaction handlers (pass no-op to disable defaults)
    onLegendClick?: (name: string) => boolean | void
    onLegendDoubleClick?: (name: string) => boolean | void
    onLegendMouseOver?: (name: string) => boolean | void
    onLegendMouseOut?: (name: string) => boolean | void
}

export type LegendHandlers<TraceName extends string = string> = {
    onLegendClick?: (name: TraceName) => boolean | void
    onLegendDoubleClick?: (name: TraceName) => boolean | void
    onLegendMouseOver?: (name: TraceName) => boolean | void
    onLegendMouseOut?: (name: TraceName) => boolean | void
}

export type OtherHandlers = {
    onRelayout?: (e: any) => void
}

export type PlotType<
    TraceName extends string = string,
    Params extends PlotParams = PlotParams
> = PlotSpec & {
    params: Params
    title: string
    heading?: ReactNode
    margin?: Partial<Margin>
    basePath?: string
} & LegendHandlers<TraceName> & OtherHandlers

export type Opts = { rmTitle?: boolean }
export const DefaultOpts: Opts = { rmTitle: true }

export function buildPlot<
    TraceName extends string = string,
    Params extends PlotParams = PlotParams
>(
    spec: PlotSpec,
    params: Params,
    opts: Opts = DefaultOpts,
): PlotType<TraceName, Params> {
    const id = spec.id
    let title = spec.title
    if (!title) {
        let { layout: { title: plotTitle } } = params
        if (typeof plotTitle === 'string') {
            title = plotTitle
        } else if (plotTitle && typeof plotTitle === 'object' && 'text' in plotTitle) {
            title = (plotTitle as { text: string }).text
        } else {
            console.error(`No title found for plot ${id}:`, params)
            throw new Error(`No title found for plot ${id}`)
        }
    }
    if (opts.rmTitle) {
        // Completely remove title from layout to avoid ghost title artifacts
        const { layout: { title: _plotTitle, ...layout } } = params
        params = { ...params, layout } as Params
    }
    return { ...spec, title, params }
}

export function buildPlots<
    TraceName extends string = string,
    Params extends PlotParams = PlotParams
>(
    specs: PlotSpec[],
    plots: { [id: string]: Params },
    opts: Opts = DefaultOpts,
): PlotType<TraceName, Params>[] {
    const plotSpecDict: { [id: string]: PlotSpec } = fromEntries(specs.map(spec => [spec.id, spec]))
    return o2a(plots, (id, plot) => {
        const spec = plotSpecDict[id]
        if (!spec) return
        return buildPlot<TraceName, Params>(spec, plot, opts)
    }).filter((p): p is PlotType<TraceName, Params> => !!p)
}

// Plot that loads its own data from JSON, or uses provided params
export function Plot<TraceName extends string = string>({
    id, name,
    title, subtitle,
    heading,
    height = DEFAULT_HEIGHT,
    src, margin,
    basePath,
    filter,
    children,
    params: providedParams,
    onLegendClick: providedOnLegendClick,
    onLegendDoubleClick: providedOnLegendDoubleClick,
    onLegendMouseOver: providedOnLegendMouseOver,
    onLegendMouseOut: providedOnLegendMouseOut,
    onRelayout,
}: PlotSpec & {
    basePath?: string
    margin?: Partial<Margin>
    heading?: ReactNode
    params?: PlotParams
} & LegendHandlers<TraceName> & OtherHandlers) {
    const [fetchedParams, setFetchedParams] = useState<PlotParams | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [xRange, setXRange] = useState<null | [number, number]>(null)
    const [soloTrace, setSoloTrace] = useState<TraceName | null>(null)
    const [hoverTrace, setHoverTrace] = useState<TraceName | null>(null)
    // Per-plot settings (scoped by plot ID)
    const [colorScaleName, setColorScaleName] = useSessionStorage<ColorScaleName>(`plot-${id}-colorscale`, 'inferno')
    // Plots with many year traces default to right legend
    const rightLegendPlots = ['ytd', 'by-month-bars']
    const defaultLegendPosition = rightLegendPlots.includes(id) ? 'right' : 'bottom'
    const [legendPosition, setLegendPosition] = useSessionStorage<'bottom' | 'right'>(`plot-${id}-legend-position`, defaultLegendPosition)
    const [ytdOnly, setYtdOnly] = useSessionStorage<boolean>(`plot-${id}-ytd-only`, false)
    const plotColors = usePlotColors()

    name = name || id

    // Load JSON data only if params not provided
    useEffect(() => {
        if (providedParams) return
        const jsonPath = `${basePath || ""}/plots/${name}.json`
        fetch(jsonPath)
            .then(res => {
                if (!res.ok) throw new Error(`Failed to load ${jsonPath}`)
                return res.json()
            })
            .then(data => setFetchedParams(data))
            .catch(err => {
                console.warn(`Could not load plot data for ${id}:`, err.message)
                setError(err.message)
            })
    }, [name, basePath, id, providedParams])

    // Use provided params or fetched params
    const params = providedParams || fetchedParams

    // Determine active trace: hover takes precedence over solo
    const activeTrace = hoverTrace ?? soloTrace

    // Check if active trace uses yaxis2
    const activeTraceUsesY2 = useMemo(() => {
        if (!activeTrace || !params) return null
        const trace = (params.data as PlotData[]).find(t => t.name === activeTrace)
        if (!trace) return null
        return (trace as any).yaxis === 'y2'
    }, [activeTrace, params])

    // Check if this plot has year traces (for YTD mode / colorscale)
    const hasYearTraces = useMemo(() => {
        if (!params) return false
        return (params.data as PlotData[]).some(t => /^20\d{2}$/.test(String(t.name)))
    }, [params])

    // Effective YTD mode: only enabled for plots with year traces
    const effectiveYtdOnly = ytdOnly && hasYearTraces

    // Get the selected colorscale (needed for annotation colors)
    const colorScale = COLORSCALES[colorScaleName]

    // Compute layout when params available
    const newLayout: Partial<Layout> | null = useMemo(
        () => {
            if (!params) return null
            const { layout } = params
            // Extract bgcolor values and template from rest to override them with theme colors
            const { margin: plotMargin, xaxis, yaxis, yaxis2, title: _title, legend, paper_bgcolor: _paperBg, plot_bgcolor: _plotBg, template: _template, ...rest } = layout
            // Increase bottom margin when legend is at bottom to prevent shifting
            const bottomMargin = legendPosition === 'bottom' ? 80 : DEFAULT_MARGIN.b
            // YTD plot gets tighter margins; others use defaults with automargin
            const isYtdPlot = id === 'ytd'
            const leftMargin = isYtdPlot ? 35 : 0
            const rightMargin = isYtdPlot ? 5 : 0
            return {
                ...rest,
                margin: { ...DEFAULT_MARGIN, ...plotMargin, ...margin, b: bottomMargin, r: rightMargin, l: leftMargin },
                dragmode: filter ? "zoom" : false,
                xaxis: (() => {
                    // Check if x-axis has year values (for 'yy formatting)
                    const tickvals = xaxis?.tickvals as number[] | undefined
                    const isYearAxis = tickvals?.length && tickvals.every(v => typeof v === 'number' && v >= 2000 && v <= 2099)

                    // Check if ticktext has month-day format like "Jan 1", "Feb 1" (show only month)
                    const ticktext = xaxis?.ticktext as string[] | undefined
                    const isMonthDayAxis = Array.isArray(ticktext) && ticktext.some(t => /^[A-Z][a-z]{2} \d+$/.test(String(t)))

                    // Check if x-axis uses datetime values with annual tick interval (dtick: "M12")
                    const isDatetimeYearAxis = xaxis?.dtick === 'M12'

                    return {
                        ...(xaxis || {}),
                        ...(filter ? {} : { fixedrange: true }),
                        tickfont: { color: plotColors.textColor },
                        gridcolor: plotColors.gridColor,
                        automargin: true,
                        tickangle: -45,  // LL to UR slant
                        // Format years as 'yy to save space
                        ...(isYearAxis ? {
                            ticktext: tickvals!.map(y => `'${String(y).slice(2)}`),
                        } : {}),
                        // Format datetime year ticks as 'yy, but show month in hover
                        ...(isDatetimeYearAxis ? {
                            tickformat: "'%y",
                            hoverformat: "%b '%y",  // "Jan '24" in tooltip
                        } : {}),
                        // Format month-day ticks as just month abbreviation
                        ...(isMonthDayAxis ? {
                            ticktext: ticktext!.map(t => {
                                // "Jan 1" -> "Jan"
                                const match = String(t).match(/^([A-Z][a-z]{2}) \d+$/)
                                return match ? match[1] : String(t)
                            }),
                        } : {}),
                        // Limit x-axis to YTD (current month/day) when enabled (only for year-trace plots)
                        ...(effectiveYtdOnly ? {
                            range: (() => {
                                const now = new Date()
                                const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
                                return [0, dayOfYear]
                            })(),
                        } : {}),
                    }
                })(),
                yaxis: (() => {
                    // For YTD mode, calculate appropriate y range from filtered data
                    let yRangeOverride: { range: [number, number] } | {} = {}
                    if (effectiveYtdOnly && params) {
                        const now = new Date()
                        const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))

                        // Helper to decode y values (handles both array and binary-encoded formats)
                        const getYValues = (trace: PlotData): number[] => {
                            const y = trace.y as unknown
                            if (!y) return []
                            if (Array.isArray(y)) {
                                return (y as unknown[]).filter((v): v is number => typeof v === 'number')
                            }
                            // Handle Plotly's binary-encoded data format
                            if (typeof y === 'object' && 'bdata' in y && 'dtype' in y) {
                                const { bdata, dtype } = y as { bdata: string; dtype: string }
                                const binary = atob(bdata)
                                const values: number[] = []
                                if (dtype === 'i2') {
                                    // int16, little-endian
                                    for (let i = 0; i < binary.length; i += 2) {
                                        const val = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8)
                                        values.push(val > 32767 ? val - 65536 : val)
                                    }
                                }
                                return values
                            }
                            return []
                        }

                        // Find max y value within YTD range across all traces
                        let maxY = 0
                        for (const trace of params.data as PlotData[]) {
                            const yValues = getYValues(trace)
                            // Use index as day-of-year (0-indexed, so check i < dayOfYear)
                            for (let i = 0; i < Math.min(dayOfYear, yValues.length); i++) {
                                maxY = Math.max(maxY, yValues[i])
                            }
                        }
                        // Add 10% padding, minimum of 10
                        yRangeOverride = { range: [0, Math.max(10, Math.ceil(maxY * 1.1))] }
                    }
                    return {
                        ...(yaxis || {}),
                        automargin: !isYtdPlot,  // YTD uses explicit margins, others use automargin
                        gridcolor: plotColors.gridColor,
                        autorange: !effectiveYtdOnly,
                        fixedrange: true,
                        tickfont: { color: plotColors.textColor, ...(isYtdPlot ? { size: 11 } : {}) },
                        title: yaxis?.title ? { text: typeof yaxis.title === 'string' ? yaxis.title : yaxis.title?.text, font: { color: plotColors.textColor }, standoff: 10 } : undefined,
                        // Hide left y-axis if active trace uses y2
                        ...(activeTraceUsesY2 === true ? { visible: false } : {}),
                        ...yRangeOverride,
                    }
                })(),
                ...(yaxis2 ? {
                    yaxis2: {
                        ...yaxis2,
                        automargin: !isYtdPlot,  // YTD uses explicit margins, others use automargin
                        gridcolor: plotColors.gridColor,
                        tickfont: { color: plotColors.textColor, ...(isYtdPlot ? { size: 11 } : {}) },
                        title: yaxis2?.title ? { text: typeof yaxis2.title === 'string' ? yaxis2.title : yaxis2.title?.text, font: { color: plotColors.textColor }, standoff: 5 } : undefined,
                        // Hide right y-axis if active trace uses y (not y2)
                        ...(activeTraceUsesY2 === false ? { visible: false } : {}),
                    }
                } : {}),
                legend: {
                    ...(legend || {}),
                    font: { color: plotColors.textColor },
                    traceorder: 'normal',
                    ...(legendPosition === 'right' ? {
                        orientation: 'v',
                        x: 1.02,
                        xanchor: 'left',
                        y: 1,
                        yanchor: 'top',
                    } : {
                        orientation: 'h',
                        x: 0.5,
                        xanchor: 'center',
                        y: -0.08,
                        yanchor: 'top',
                    }),
                },
                hovermode: 'x unified',
                hoverlabel: {
                    bgcolor: plotColors.legendBg,
                    bordercolor: plotColors.gridColor,
                    font: { color: plotColors.textColor },
                },
                height,
                autosize: true,
                paper_bgcolor: plotColors.paperBg,
                plot_bgcolor: plotColors.plotBg,
                // Force axis recalculation when YTD mode changes
                datarevision: effectiveYtdOnly ? 'ytd' : 'full',
                // Add annotations when a trace is active - only for specific plots (by-month-bars)
                ...(activeTrace && params && id === 'by-month-bars' ? (() => {
                    const traces = params.data as PlotData[]
                    const barTraces = traces.filter(t => t.type === 'bar')
                    const numBars = barTraces.length

                    // Find the active trace (match against original name or 'yy format)
                    let traceIndex = -1
                    let originalName = ''
                    const trace = barTraces.find((t, idx) => {
                        const tName = String(t.name || '')
                        const displayName = /^20\d{2}$/.test(tName) ? `'${tName.slice(2)}` : tName
                        if (tName === activeTrace || displayName === activeTrace) {
                            traceIndex = idx
                            originalName = tName
                            return true
                        }
                        return false
                    })
                    if (!trace || traceIndex === -1) return {}

                    // Get trace color from colorscale for year traces
                    let traceColor: string
                    const yearMatch = originalName.match(/^20\d{2}$/)
                    if (yearMatch) {
                        const year = parseInt(yearMatch[0])
                        const minYear = 2008, maxYear = 2026
                        const t = (year - minYear) / (maxYear - minYear)
                        traceColor = getColorAt(colorScale, t)
                    } else {
                        traceColor = typeof trace.marker?.color === 'string' ? trace.marker.color : plotColors.textColor
                    }

                    // Helper to decode binary-encoded Plotly data
                    const decodeData = (data: unknown): (string | number)[] => {
                        if (Array.isArray(data)) return data as (string | number)[]
                        if (typeof data === 'object' && data && 'bdata' in data && 'dtype' in data) {
                            const { bdata, dtype } = data as { bdata: string; dtype: string }
                            const binary = atob(bdata)
                            const values: number[] = []
                            if (dtype === 'i1') {
                                for (let i = 0; i < binary.length; i++) {
                                    values.push(binary.charCodeAt(i) > 127 ? binary.charCodeAt(i) - 256 : binary.charCodeAt(i))
                                }
                            } else if (dtype === 'i2') {
                                for (let i = 0; i < binary.length; i += 2) {
                                    const val = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8)
                                    values.push(val > 32767 ? val - 65536 : val)
                                }
                            } else if (dtype === 'i4') {
                                for (let i = 0; i < binary.length; i += 4) {
                                    const val = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8) |
                                                (binary.charCodeAt(i + 2) << 16) | (binary.charCodeAt(i + 3) << 24)
                                    values.push(val)
                                }
                            }
                            return values
                        }
                        return []
                    }

                    const xs = decodeData(trace.x)
                    const ys = decodeData(trace.y)
                    if (!xs.length || !ys.length) return {}

                    // Calculate x offset to center annotation over the specific bar
                    const groupWidth = 0.8
                    const barWidth = groupWidth / numBars
                    const groupStart = -groupWidth / 2
                    const barCenter = groupStart + barWidth * traceIndex + barWidth / 2

                    const annotations = xs.map((x, i) => ({
                        x: (x as number) + barCenter,
                        y: ys[i] as number,
                        text: `<b>${Math.round((ys[i] as number) || 0)}</b>`,
                        showarrow: false,
                        yshift: 18,
                        font: { color: traceColor, size: 14 },
                        bgcolor: 'rgba(0, 0, 0, 0.6)',  // Dark background for contrast
                        borderpad: 2,
                    }))
                    return { annotations }
                })() : {}),
            }
        },
        [params, margin, height, xRange, filter, plotColors, activeTraceUsesY2, legendPosition, effectiveYtdOnly, activeTrace, id, colorScale]
    )

    // Color adjustments for dark mode visibility
    const adjustColorForDarkMode = (color: string | undefined, traceName?: string): string | undefined => {
        if (!color) return color
        const lower = color.toLowerCase()

        // Year traces (2008-2026): Apply selected colorscale
        const yearMatch = traceName?.match(/^20\d{2}$/)
        if (yearMatch) {
            const year = parseInt(yearMatch[0])
            const minYear = 2008, maxYear = 2026
            // t=0 for oldest year (dark), t=1 for newest (bright) - chronological order
            const t = (year - minYear) / (maxYear - minYear)
            return getColorAt(colorScale, t)
        }

        // Black-ish colors - use context-aware replacement
        if (lower === '#000004' || lower === 'black' || lower === '#000' || lower === '#000000') {
            // 12mo avg line -> white for max contrast
            if (traceName?.toLowerCase().includes('avg') || traceName?.toLowerCase().includes('12mo')) {
                return '#ffffff'
            }
            // Homicides -> saturated blue-purple
            return '#8080d0'
        }

        // Check hex colors close to black
        if (lower.startsWith('#')) {
            const hex = lower.slice(1)
            let r = 0, g = 0, b = 0
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16)
                g = parseInt(hex[1] + hex[1], 16)
                b = parseInt(hex[2] + hex[2], 16)
            } else if (hex.length === 6) {
                r = parseInt(hex.slice(0, 2), 16)
                g = parseInt(hex.slice(2, 4), 16)
                b = parseInt(hex.slice(4, 6), 16)
            }
            // If too dark, lighten it
            if (r < 40 && g < 40 && b < 40) {
                return '#a0a0a0'
            }
        }
        return color
    }

    // Compute filtered traces when params available, applying solo/hover visibility
    const filteredTraces: PlotData[] | null = useMemo(() => {
        if (!params) return null
        let data = params.data as PlotData[]
        if (filter && xRange) {
            data = filter({ data, xRange })
        }

        // Filter data to YTD range if enabled (only for plots with year traces)
        if (effectiveYtdOnly) {
            const now = new Date()
            const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24))
            data = data.map(trace => {
                const x = trace.x
                const y = trace.y
                if (!x || !y || !Array.isArray(x) || !Array.isArray(y)) return trace
                // Filter to only include points within YTD range
                const filtered = (x as number[]).map((xVal, i) => ({ x: xVal, y: (y as number[])[i] }))
                    .filter(pt => typeof pt.x === 'number' && pt.x <= dayOfYear)
                return {
                    ...trace,
                    x: filtered.map(pt => pt.x),
                    y: filtered.map(pt => pt.y),
                }
            })
        }

        // Sort traces by name chronologically (year traces like "2008", "2009")
        // This ensures bar charts show years left-to-right in ascending order
        data = [...data].sort((a, b) => {
            const aName = String(a.name || '')
            const bName = String(b.name || '')
            // If both are years, sort chronologically ascending
            if (/^20\d{2}$/.test(aName) && /^20\d{2}$/.test(bName)) {
                return parseInt(aName) - parseInt(bName)
            }
            return 0  // Keep original order for non-year traces
        })
        // Process traces: apply visibility and clean up marker/line settings for dark mode
        const ACTIVE_LINE_WIDTH = 5
        const INACTIVE_LINE_WIDTH = 1.5

        // Fade color while preserving some hue (HSL transform)
        const fadeColor = (hexColor: string): string => {
            // Parse hex to RGB
            const hex = hexColor.replace('#', '')
            const r = parseInt(hex.slice(0, 2), 16) / 255
            const g = parseInt(hex.slice(2, 4), 16) / 255
            const b = parseInt(hex.slice(4, 6), 16) / 255

            // RGB to HSL
            const max = Math.max(r, g, b), min = Math.min(r, g, b)
            let h = 0, s = 0, l = (max + min) / 2

            if (max !== min) {
                const d = max - min
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
                switch (max) {
                    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
                    case g: h = ((b - r) / d + 2) / 6; break
                    case b: h = ((r - g) / d + 4) / 6; break
                }
            }

            // Reduce saturation and lightness for faded effect
            s = s * 0.3  // Keep 30% saturation
            l = Math.max(0.25, l * 0.5)  // Darken but keep minimum lightness

            // HSL to RGB
            const hue2rgb = (p: number, q: number, t: number) => {
                if (t < 0) t += 1
                if (t > 1) t -= 1
                if (t < 1/6) return p + (q - p) * 6 * t
                if (t < 1/2) return q
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
                return p
            }

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s
            const p = 2 * l - q
            const nr = Math.round(hue2rgb(p, q, h + 1/3) * 255)
            const ng = Math.round(hue2rgb(p, q, h) * 255)
            const nb = Math.round(hue2rgb(p, q, h - 1/3) * 255)

            return `rgb(${nr}, ${ng}, ${nb})`
        }

        // Check if this is a bar chart (reordering would change bar positions in grouped mode)
        const hasBarTraces = data.some(t => t.type === 'bar')

        // Assign legendrank before reordering to preserve legend order
        data = data.map((trace, idx) => ({ ...trace, legendrank: idx }))

        // Reorder for z-order (selected trace drawn on top) - skip for bar charts
        if (activeTrace !== null && !hasBarTraces) {
            // Match against both original name and 'yy format
            const selectedIdx = data.findIndex(t => {
                const name = String(t.name || '')
                const displayName = /^20\d{2}$/.test(name) ? `'${name.slice(2)}` : name
                return name === activeTrace || displayName === activeTrace
            })
            if (selectedIdx !== -1) {
                const [selected] = data.splice(selectedIdx, 1)
                data.push(selected)
            }
        }

        data = data.map(trace => {
            const newTrace = { ...trace }
            const originalName = String(trace.name || '')

            // Format year trace names as 'yy for shorter legend labels
            const displayName = /^20\d{2}$/.test(originalName) ? `'${originalName.slice(2)}` : originalName
            newTrace.name = displayName

            // Match activeTrace against both original and display names
            const matchesActive = activeTrace !== null && (originalName === activeTrace || displayName === activeTrace)
            const isSelected = matchesActive
            const isGreyedOut = activeTrace !== null && !matchesActive

            // Fix bar markers for dark mode
            if (trace.type === 'bar' && trace.marker) {
                const markerColor = typeof trace.marker.color === 'string' ? trace.marker.color : undefined
                const adjustedColor = adjustColorForDarkMode(markerColor, originalName)
                newTrace.marker = {
                    ...trace.marker,
                    color: isGreyedOut && adjustedColor ? fadeColor(adjustedColor) : adjustedColor,
                    // Remove bar outlines
                    line: { color: 'transparent', width: 0 },
                }
                // For by-month-bars: control z-order so selected trace is on top
                if (id === 'by-month-bars') {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const nt = newTrace as any
                    if (isSelected) {
                        nt.width = 0.25   // Wider bar for selected trace
                        nt.zorder = 100   // Draw on top of other traces
                    } else if (activeTrace !== null) {
                        nt.zorder = 1     // Push non-selected traces behind
                    }
                }
            }
            // Fix line colors for scatter/line traces
            if ((trace.type === 'scatter' || trace.type === 'scattergl') && trace.line) {
                const lineColor = typeof trace.line.color === 'string' ? trace.line.color : undefined
                const adjustedColor = adjustColorForDarkMode(lineColor, originalName)
                let color = adjustedColor
                let width = trace.line.width ?? 2
                if (isSelected) {
                    // For grayscale, use white for selected; otherwise keep original color
                    color = colorScaleName === 'grayscale' ? '#ffffff' : adjustedColor
                    width = ACTIVE_LINE_WIDTH
                } else if (isGreyedOut && adjustedColor) {
                    color = fadeColor(adjustedColor)
                    width = INACTIVE_LINE_WIDTH
                }
                newTrace.line = {
                    ...trace.line,
                    color,
                    width,
                }
            }
            return newTrace
        })
        return data
    }, [params, xRange, filter, activeTrace, plotColors, colorScale, colorScaleName, effectiveYtdOnly, id])

    // Default legend click handler: solo trace on click
    const onLegendClick = useMemo(() => {
        if (providedOnLegendClick) return providedOnLegendClick
        return (name: TraceName) => {
            if (soloTrace === name) {
                setSoloTrace(null)  // Un-solo if already solo'd
                setHoverTrace(null)
            } else {
                setSoloTrace(name)  // Solo this trace
            }
            return false  // Prevent default Plotly behavior
        }
    }, [providedOnLegendClick, soloTrace])

    // Default legend double-click handler: show all
    const onLegendDoubleClick = useMemo(() => {
        if (providedOnLegendDoubleClick) return providedOnLegendDoubleClick
        return () => {
            setSoloTrace(null)
            setHoverTrace(null)
            return false
        }
    }, [providedOnLegendDoubleClick])

    // Default legend hover handlers: preview trace on hover
    const onLegendMouseOver = useMemo(() => {
        if (providedOnLegendMouseOver) return providedOnLegendMouseOver
        return (name: TraceName) => {
            setHoverTrace(name)
            return true
        }
    }, [providedOnLegendMouseOver])

    const onLegendMouseOut = useMemo(() => {
        if (providedOnLegendMouseOut) return providedOnLegendMouseOut
        return () => {
            setHoverTrace(null)
            return true
        }
    }, [providedOnLegendMouseOut])

    if (src === undefined) {
        src = `plots/${name}.png`
    }

    // Show fallback image if data not loaded
    if (!params || !newLayout || !filteredTraces) {
        const imgSrc = `${basePath || ""}/${src}`
        return (
            <div id={id} key={id} className="plot">
                {heading ?? (title && <h2><a href={`#${id}`}>{title}</a></h2>)}
                {subtitle}
                <div style={{ height: `${height}px`, position: 'relative' }}>
                    <img
                        src={imgSrc}
                        alt={title || name || id}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        loading="lazy"
                    />
                    {!error && (
                        <div style={{
                            position: 'absolute',
                            bottom: '10px',
                            left: '10px',
                            background: 'rgba(255,255,255,0.8)',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '12px',
                        }}>
                            Loading interactive plot...
                        </div>
                    )}
                </div>
                {children}
            </div>
        )
    }

    return (
        <div id={id} key={id} className="plot">
            {heading ?? (title && <h2><a href={`#${id}`}>{title}</a></h2>)}
            {subtitle}
            <PlotWrapper
                id={id}
                data={filteredTraces}
                layout={newLayout}
                src={src}
                basePath={basePath}
                onRelayout={(e: any) => {
                    if (filter && e["xaxis.range[0]"] !== undefined) {
                        setXRange([e["xaxis.range[0]"], e["xaxis.range[1]"]])
                    } else if (e["xaxis.autorange"]) {
                        setXRange(null)
                    }
                    onRelayout?.(e)
                }}
                onLegendClick={onLegendClick as any}
                onLegendDoubleClick={onLegendDoubleClick as any}
                onLegendMouseOver={onLegendMouseOver as any}
                onLegendMouseOut={onLegendMouseOut as any}
            />
            {hasYearTraces && (
                <div style={{ marginTop: '0.5em', fontSize: '12px', display: 'flex', gap: '1em', flexWrap: 'wrap' }}>
                    <div>
                        <label style={{ marginRight: '0.5em' }}>Colors:</label>
                        <select
                            value={colorScaleName}
                            onChange={e => setColorScaleName(e.target.value as ColorScaleName)}
                            style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                border: '1px solid var(--border-primary)',
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                fontSize: '12px',
                            }}
                        >
                            <option value="inferno">Inferno</option>
                            <option value="viridis">Viridis</option>
                            <option value="plasma">Plasma</option>
                            <option value="grayscale">Grayscale</option>
                            <option value="blueOrange">Blue → Orange</option>
                        </select>
                    </div>
                    <div>
                        <label style={{ marginRight: '0.5em' }}>Legend:</label>
                        <select
                            value={legendPosition}
                            onChange={e => setLegendPosition(e.target.value as 'bottom' | 'right')}
                            style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                border: '1px solid var(--border-primary)',
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                fontSize: '12px',
                            }}
                        >
                            <option value="bottom">Bottom</option>
                            <option value="right">Right</option>
                        </select>
                    </div>
                    {id === 'ytd' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3em', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={ytdOnly}
                                onChange={e => setYtdOnly(e.target.checked)}
                            />
                            YTD only
                        </label>
                    )}
                </div>
            )}
            {children}
        </div>
    )
}
