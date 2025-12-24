// Vite replacement for @rdub/next-plotly/plot
// Simplified version that loads plot data client-side

import React, { CSSProperties, ReactNode, useEffect, useMemo, useState } from "react"
import { PlotParams } from "react-plotly.js"
import { Datum, Layout, Legend, Margin, PlotData } from "plotly.js"
import { fromEntries, o2a } from "@rdub/base/objs"
import PlotWrapper from "./plot-wrapper"

export const DEFAULT_HEIGHT = 400
export const DEFAULT_MARGIN: Partial<Margin> = { t: 20, b: 40, l: 40, r: 20 }

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
}

export type LegendHandlers<TraceName extends string = string> = {
    onLegendClick?: (name: TraceName) => boolean | void
    onLegendDoubleClick?: (name: TraceName) => boolean | void
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
        let { layout: { title: plotTitle, ...layout } } = params
        if (typeof plotTitle === 'string') {
            params = { ...params, layout } as Params
        } else if (plotTitle) {
            const { text, ...restTitle } = plotTitle as { text?: string; [key: string]: any }
            params = { ...params, layout: { ...layout, title: restTitle } } as Params
        }
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
    onLegendClick,
    onLegendDoubleClick,
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

    // Compute layout when params available
    const newLayout: Partial<Layout> | null = useMemo(
        () => {
            if (!params) return null
            const { layout } = params
            const { margin: plotMargin, xaxis, yaxis, ...rest } = layout
            return {
                margin: { ...DEFAULT_MARGIN, ...plotMargin, ...margin },
                dragmode: filter ? "zoom" : false,
                xaxis: {
                    ...(filter ? {} : { fixedrange: true }),
                    ...(xaxis || {}),
                },
                yaxis: {
                    automargin: true,
                    gridcolor: "#ccc",
                    autorange: true,
                    fixedrange: true,
                    ...(yaxis || {}),
                },
                height,
                autosize: true,
                ...rest
            }
        },
        [params, margin, height, xRange, filter]
    )

    // Compute filtered traces when params available
    const filteredTraces: PlotData[] | null = useMemo(() => {
        if (!params) return null
        const data = params.data as PlotData[]
        return (filter && xRange) ? filter({ data, xRange }) : data
    }, [params, xRange, filter])

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
            />
            {children}
        </div>
    )
}
