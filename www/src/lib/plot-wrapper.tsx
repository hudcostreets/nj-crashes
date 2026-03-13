import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { useLegendHover, usePlotlyHoverDismiss, LegendClickEvent } from "pltly"

const PlotlyComponent = lazy(() => import("react-plotly.js"))

export type LegendHandlers = {
    onLegendClick?: (event: LegendClickEvent) => boolean | void
    onLegendDoubleClick?: () => boolean | void
    onHoverTrace?: (name: string | null) => void
    onResetSolo?: () => void
}

export type OtherHandlers = {
    onRelayout?: (e: PlotRelayoutEvent) => void
    onHover?: (event: any) => void
    onUnhover?: (event: any) => void
}

export type Props = {
    id?: string
    data: PlotData[]
    layout: Partial<Layout>
    className?: string
} & LegendHandlers & OtherHandlers

export const DEFAULT_MARGIN: Partial<Margin> = { t: 0, r: 15, b: 0, l: 0 }
export const DEFAULT_HEIGHT = 450

export default function PlotWrapper({
    id,
    data,
    layout,
    className,
    onLegendClick,
    onLegendDoubleClick,
    onHoverTrace,
    onResetSolo,
    onRelayout,
    onHover,
    onUnhover,
}: Props) {
    const [initialized, setInitialized] = useState(false)
    const height = layout.height ?? DEFAULT_HEIGHT
    const containerRef = useRef<HTMLDivElement>(null)
    const setupHoverDismiss = usePlotlyHoverDismiss(containerRef)

    // Legend hover via pltly
    const traceNames = useMemo(
        () => data.filter(t => t.showlegend !== false).map(t => String(t.name ?? '')).filter(Boolean),
        [data],
    )
    const { hoverTrace, handlers: legendHoverHandlers } = useLegendHover(containerRef, traceNames)

    // Forward hover state to consumer
    useEffect(() => {
        onHoverTrace?.(hoverTrace)
    }, [hoverTrace])

    return (
        <div
            ref={containerRef}
            className={`plot-wrapper ${className || ""}`}
            style={{
                minHeight: `${height}px`,
                WebkitTouchCallout: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none',
                // @ts-ignore - WebkitTapHighlightColor is a valid CSS property for mobile Safari
                WebkitTapHighlightColor: 'transparent',
            }}
            onContextMenu={e => e.preventDefault()}
        >
            {!initialized && (
                <div style={{
                    height: `${height}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.5,
                }}>Loading...</div>
            )}
            <Suspense fallback={null}>
                <PlotlyComponent
                    onInitialized={() => {
                        setInitialized(true)
                        setupHoverDismiss()
                        legendHoverHandlers.onInitialized()
                    }}
                    onUpdate={() => {
                        setupHoverDismiss()
                        legendHoverHandlers.onUpdate()
                    }}
                    onLegendClick={e => {
                        if (onLegendClick) {
                            const result = onLegendClick(e as LegendClickEvent)
                            return result === undefined ? true : result
                        }
                        return true
                    }}
                    onLegendDoubleClick={() => {
                        if (onLegendDoubleClick) {
                            const result = onLegendDoubleClick()
                            return result === undefined ? true : result
                        }
                        return true
                    }}
                    onRelayout={e => onRelayout?.(e)}
                    onHover={onHover}
                    onUnhover={onUnhover}
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
