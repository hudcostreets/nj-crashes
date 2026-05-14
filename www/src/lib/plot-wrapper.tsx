import React from "react"
import type { PlotData, Layout, Margin, PlotRelayoutEvent } from "plotly.js"
import { Plot } from "pltly/react"
import type { StyleFn } from "pltly/react"
import { LegendClickEvent } from "pltly"

export type LegendHandlers = {
    onLegendClick?: (event: LegendClickEvent) => boolean | void
    onLegendDoubleClick?: () => boolean | void
    /** Called when active trace changes (hovered or solo'd). null = none active. */
    onActiveTrace?: (name: string | null) => void
    /** Called when hover trace changes (transient). null = not hovering. */
    onHoverTrace?: (name: string | null) => void
    /** Called when solo/pin changes (click only, not hover). null = unpinned. */
    onSoloTrace?: (name: string | null) => void
    onResetSolo?: () => void
}

export type OtherHandlers = {
    onRelayout?: (e: PlotRelayoutEvent) => void
    onHover?: (event: any) => void
    onUnhover?: (event: any) => void
    onClickAnnotation?: (event: { index: number; annotation: any; fullAnnotation: any }) => void
    onHoverAnnotation?: (event: { index: number; annotation: any; fullAnnotation: any }) => void
    onUnhoverAnnotation?: (event: { index: number; annotation: any; fullAnnotation: any }) => void
}

export type Props = {
    id?: string
    data: PlotData[]
    layout: Partial<Layout>
    className?: string
    /** Disable pltly's built-in fade (for plots that apply their own custom fade).
     *  Legend hover detection and solo/pin still work when callbacks are provided. */
    disableFade?: boolean
    /** Disable pltly's solo/pin on legend click (but still allow hover detection) */
    disableSolo?: boolean
    /** Fade the non-associated Y-axis on dual-axis plots when a trace is highlighted */
    fadeInactiveAxis?: boolean
    /** Font-weight for active legend items. Pass 'normal' to disable bolding
     *  (prevents flicker at legend-item boundaries on hover). */
    boldWeight?: number | 'bold' | 'normal'
    /** Style override for the active trace (passed through to pltly). */
    activeStyle?: StyleFn
    /** Style override for non-active traces while a trace is active. */
    inactiveStyle?: StyleFn
    /** Content shown while Plotly is initializing (after mount, before first paint).
     *  Defaults to pltly's centered "Loading..." text; pass `null` to hide entirely. */
    fallback?: React.ReactNode
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
    onSoloTrace,
    onResetSolo,
    onRelayout,
    onHover,
    onUnhover,
    onClickAnnotation,
    onHoverAnnotation,
    onUnhoverAnnotation,
    disableFade,
    disableSolo,
    fadeInactiveAxis,
    boldWeight,
    activeStyle,
    inactiveStyle,
    fallback,
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
            onSoloTraceChange={onSoloTrace}
            onHover={onHover}
            onUnhover={onUnhover}
            onResetSolo={onResetSolo}
            onClickAnnotation={onClickAnnotation}
            onHoverAnnotation={onHoverAnnotation}
            onUnhoverAnnotation={onUnhoverAnnotation}
            disableLegendHover={disableFade}
            disableSoloTrace={disableSolo}
            fadeInactiveAxis={fadeInactiveAxis}
            boldWeight={boldWeight}
            activeStyle={activeStyle}
            inactiveStyle={inactiveStyle}
            fallback={fallback !== undefined ? fallback : (
                <div style={{
                    height: `${height}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.5,
                }}>Loading...</div>
            )}
        />
    )
}
