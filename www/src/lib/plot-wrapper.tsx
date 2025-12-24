// Vite replacement for @rdub/next-plotly/plot-wrapper
// Simplified version without next/image and next/dynamic
import React, { lazy, Suspense, useEffect, useRef, useState } from "react"
import { PlotParams } from "react-plotly.js"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { getBasePath } from "./basePath"

// Lazy load Plotly to avoid SSR issues
const PlotlyComponent = lazy(() => import("react-plotly.js"))

export type LegendHandlers<TraceName extends string = string> = {
    onLegendClick?: (name: TraceName) => boolean | void
    onLegendDoubleClick?: (name: TraceName) => boolean | void
}

export type OtherHandlers = {
    onRelayout?: (e: PlotRelayoutEvent) => void
}

export type Props<Trace extends string = string> = {
    data: PlotData[]
    layout: Partial<Layout>
    src?: string
    basePath?: string
    className?: string
} & LegendHandlers<Trace> & OtherHandlers

export const DEFAULT_MARGIN: Partial<Margin> = { t: 0, r: 15, b: 0, l: 0 }
export const DEFAULT_HEIGHT = 450

export default function PlotWrapper<TraceName extends string = string>({
    data,
    layout,
    src,
    basePath,
    className,
    onLegendClick,
    onLegendDoubleClick,
    onRelayout,
}: Props<TraceName>) {
    const [initialized, setInitialized] = useState(false)
    const height = layout.height ?? DEFAULT_HEIGHT

    basePath = basePath || getBasePath() || ""
    const fallbackSrc = src ? `${basePath}/${src}` : undefined

    return (
        <div className={`plot-wrapper ${className || ""}`}>
            {/* Fallback image while Plotly loads */}
            {!initialized && fallbackSrc && (
                <div
                    className="plot-fallback"
                    style={{ height: `${height}px`, maxHeight: `${height}px`, position: 'relative' }}
                >
                    <img
                        src={fallbackSrc}
                        alt="Plot loading..."
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        loading="lazy"
                    />
                    <div className="spinner" style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                    }}>Loading...</div>
                </div>
            )}
            <Suspense fallback={null}>
                <PlotlyComponent
                    onInitialized={() => setInitialized(true)}
                    onLegendClick={e => {
                        if (onLegendClick) {
                            const { curveNumber, data: plotData } = e
                            const { name } = plotData[curveNumber]
                            if (name === undefined) {
                                console.error(`No data trace found at curve number ${curveNumber}:`, e)
                                return true
                            }
                            const result = onLegendClick(name as TraceName)
                            return result === undefined ? true : result
                        }
                        return true
                    }}
                    onLegendDoubleClick={e => {
                        if (onLegendDoubleClick) {
                            const { curveNumber, data: plotData } = e
                            const { name } = plotData[curveNumber]
                            if (name === undefined) {
                                console.error(`No data trace found at curve number ${curveNumber}:`, e)
                                return true
                            }
                            const result = onLegendDoubleClick(name as TraceName)
                            return result === undefined ? true : result
                        }
                        return true
                    }}
                    onRelayout={e => onRelayout?.(e)}
                    className="plotly"
                    data={data}
                    config={{ displayModeBar: false, scrollZoom: false, responsive: true }}
                    style={{
                        visibility: initialized ? undefined : "hidden",
                        width: "100%",
                    }}
                    layout={layout}
                />
            </Suspense>
        </div>
    )
}
