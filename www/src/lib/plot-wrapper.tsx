import React from "react"
import { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { Plot } from "pltly/react"
import { LegendClickEvent } from "pltly"

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
    /** Disable pltly's built-in legend hover highlight */
    disableLegendHover?: boolean
    /** Disable pltly's built-in click-to-solo */
    disableSoloTrace?: boolean
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
    disableLegendHover,
    disableSoloTrace,
}: Props) {
    const height = layout.height ?? DEFAULT_HEIGHT

    return (
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
            disableLegendHover={disableLegendHover ?? true}
            disableSoloTrace={disableSoloTrace ?? true}
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
