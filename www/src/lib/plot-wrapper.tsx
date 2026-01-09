// Vite replacement for @rdub/next-plotly/plot-wrapper
// Simplified version without next/image and next/dynamic
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { PlotParams } from "react-plotly.js"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { getBasePath } from "./basePath"

// Lazy load Plotly to avoid SSR issues
const PlotlyComponent = lazy(() => import("react-plotly.js"))

export type LegendHandlers<TraceName extends string = string> = {
    onLegendClick?: (name: TraceName) => boolean | void
    onLegendDoubleClick?: (name: TraceName) => boolean | void
    onLegendMouseOver?: (name: TraceName) => boolean | void
    onLegendMouseOut?: (name: TraceName) => boolean | void
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

export type PlotWrapperProps<TraceName extends string = string> = Props<TraceName> & { id?: string }

export default function PlotWrapper<TraceName extends string = string>({
    id,
    data,
    layout,
    src,
    basePath,
    className,
    onLegendClick,
    onLegendDoubleClick,
    onLegendMouseOver,
    onLegendMouseOut,
    onRelayout,
}: PlotWrapperProps<TraceName>) {
    const [initialized, setInitialized] = useState<{ graphDiv: HTMLElement } | null>(null)
    const height = layout.height ?? DEFAULT_HEIGHT

    basePath = basePath || getBasePath() || ""
    const fallbackSrc = src ? `${basePath}/${src}` : undefined

    // Set up legend hover events after Plotly initializes
    useEffect(() => {
        if (!initialized) return
        if (!onLegendMouseOver && !onLegendMouseOut) return

        const { graphDiv } = initialized
        const legend = graphDiv.getElementsByClassName('legend')[0]
        if (!legend) return

        const legendGroups = Array.from(legend.getElementsByClassName('groups'))
        const listeners: Array<[Element, Record<string, () => void>]> = []

        // Build list of traces that appear in legend (showlegend !== false)
        const visibleTraces = data.filter(trace => trace.showlegend !== false)

        legendGroups.forEach((group, idx) => {
            const traceName = visibleTraces[idx]?.name as TraceName
            if (!traceName) return

            const groupListeners: Record<string, () => void> = {}

            if (onLegendMouseOver) {
                const overListener = () => onLegendMouseOver(traceName)
                group.addEventListener('mouseover', overListener)
                groupListeners.mouseover = overListener
            }
            if (onLegendMouseOut) {
                const outListener = () => onLegendMouseOut(traceName)
                group.addEventListener('mouseout', outListener)
                groupListeners.mouseout = outListener
            }

            listeners.push([group, groupListeners])
        })

        // Cleanup
        return () => {
            listeners.forEach(([group, groupListeners]) => {
                Object.entries(groupListeners).forEach(([event, handler]) => {
                    group.removeEventListener(event, handler)
                })
            })
        }
    }, [initialized, data, onLegendMouseOver, onLegendMouseOut])

    return (
        <div className={`plot-wrapper ${className || ""}`} style={{ minHeight: `${height}px` }}>
            {/* Fallback image while Plotly loads */}
            {initialized === null && fallbackSrc && (
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
                    onInitialized={(figure, graphDiv) => {
                        setInitialized({ graphDiv })
                    }}
                    onUpdate={(figure, graphDiv) => {
                        // Re-setup if graphDiv changes
                        if (initialized?.graphDiv !== graphDiv) {
                            setInitialized({ graphDiv })
                        }
                    }}
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
                        height: `${height}px`,
                        minHeight: `${height}px`,
                    }}
                    layout={layout}
                />
            </Suspense>
        </div>
    )
}
