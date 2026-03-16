import React from "react"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { Plot } from "pltly/react"
import { LegendClickEvent } from "pltly"

export type LegendHandlers = {
    onLegendClick?: (event: LegendClickEvent) => boolean | void
    onLegendDoubleClick?: () => boolean | void
    /** Called when active trace changes (hovered or solo'd). null = none active. */
    onActiveTrace?: (name: string | null) => void
    /** Called when hover trace changes (transient). null = not hovering. */
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
    /** Disable pltly's built-in fade (for plots that apply their own custom fade) */
    disableFade?: boolean
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
    onActiveTrace,
    onHoverTrace,
    onResetSolo,
    onRelayout,
    onHover,
    onUnhover,
    disableFade,
}: Props) {
    const height = layout.height ?? DEFAULT_HEIGHT

    return (
        <Plot
            data={data as any}
            layout={layout as any}
            config={{ displayModeBar: false, scrollZoom: false, responsive: true }}
            style={{
                width: "100%",
                height: `${height}px`,
                minHeight: `${height}px`,
            }}
            onLegendClick={onLegendClick as ((data: unknown) => boolean) | undefined}
            onLegendDoubleClick={onLegendDoubleClick as (() => boolean) | undefined}
            onRelayout={onRelayout as any}
            onActiveTraceChange={onActiveTrace}
            onHoverTraceChange={onHoverTrace}
            disableLegendHover={disableFade}
            disableSoloTrace={disableFade}
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
    )
}
