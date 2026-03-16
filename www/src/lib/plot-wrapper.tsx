import React, { useEffect, useMemo, useRef } from "react"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { Plot } from "pltly/react"
import { LegendClickEvent, useLegendHover } from "pltly"

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
    const height = layout.height ?? DEFAULT_HEIGHT
    const containerRef = useRef<HTMLDivElement>(null)

    // Legend hover detection (forwarded to consumer, no auto-fading)
    const traceNames = useMemo(
        () => data.filter(t => t.showlegend !== false).map(t => String(t.name ?? '')).filter(Boolean),
        [data],
    )
    const { hoverTrace, handlers: legendHoverHandlers } = useLegendHover(containerRef, traceNames)

    useEffect(() => {
        onHoverTrace?.(hoverTrace)
    }, [hoverTrace])

    return (
        <div ref={containerRef}>
            <Plot
                data={data}
                layout={layout}
                config={{ displayModeBar: false, scrollZoom: false, responsive: true }}
                style={{
                    width: "100%",
                    height: `${height}px`,
                    minHeight: `${height}px`,
                }}
                onLegendClick={onLegendClick as ((data: unknown) => boolean) | undefined}
                onLegendDoubleClick={onLegendDoubleClick as (() => boolean) | undefined}
                onRelayout={onRelayout}
                onInitialized={legendHoverHandlers.onInitialized}
                onUpdate={legendHoverHandlers.onUpdate}
                disableLegendHover
                disableSoloTrace
                fallback={
                    <div style={{
                        height: `${height}px`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: 0.5,
                    }}>Loading...</div>
                }
            />
        </div>
    )
}
