/** Small embedded map (crash detail page, road page): the same MapLibre + Stadia basemap and
 *  deck.gl overlay as `CrashMap`, minus its modes/controls. Top-down; scroll-wheel zoom is off so
 *  the page still scrolls over it (drag / pinch / double-click / the ± buttons zoom). */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Map as MapGl, type MapRef } from "react-map-gl/maplibre"
import "./maplibreWorker"
import "maplibre-gl/dist/maplibre-gl.css"
import DeckGL from "@deck.gl/react"
import { WebMercatorViewport, type PickingInfo } from "@deck.gl/core"
import { AttributionPopover, rasterStyle } from "./basemap"
import { useDeckMapCapture } from "@/src/feedback/glCapture"

export type MiniView = { longitude: number; latitude: number; zoom: number }
export type Bbox = [number, number, number, number]

const MAX_ZOOM = 19

export type MiniMapProps = {
    height: number
    theme: "light" | "dark"
    /** Initial view: a centre + zoom, or bounds to fit (`[w, s, e, n]`). */
    center?: MiniView
    bounds?: Bbox
    layers: any[]
    onHover?: (info: PickingInfo) => void
    onClick?: (info: PickingInfo) => void
    /** Pointer cursor while something pickable is hovered. */
    hovering?: boolean
    /** Overlays (tooltips, legends) positioned within the map box. */
    children?: React.ReactNode
}

function fitView(bounds: Bbox, width: number, height: number): MiniView {
    const [w, s, e, n] = bounds
    // A point-sized bbox (one-MP road) would fit to an absurd zoom.
    const pad = 0.0005
    const vp = new WebMercatorViewport({ width, height }).fitBounds(
        [[w - pad, s - pad], [e + pad, n + pad]],
        { padding: Math.min(30, width / 8, height / 8) },
    )
    return { longitude: vp.longitude, latitude: vp.latitude, zoom: Math.min(vp.zoom, 17) }
}

export default function MiniMap({ height, theme, center, bounds, layers, onHover, onClick, hovering, children }: MiniMapProps) {
    const ref = useRef<HTMLDivElement>(null)
    const mapRef = useRef<MapRef | null>(null)
    const { deckRef, onAfterRender } = useDeckMapCapture(mapRef)
    const [home, setHome] = useState<MiniView | null>(null)
    const [view, setView] = useState<MiniView | null>(null)
    const boundsKey = bounds?.join(",")
    useLayoutEffect(() => {
        const width = ref.current?.clientWidth ?? 0
        const v = bounds && width ? fitView(bounds, width, height) : center ?? null
        setHome(v)
        setView(v)
    }, [boundsKey, center?.latitude, center?.longitude, center?.zoom, height])

    const style = useMemo(() => rasterStyle(theme), [theme])
    const zoomBy = useCallback((dz: number) => setView(v => v && { ...v, zoom: Math.max(0, Math.min(MAX_ZOOM, v.zoom + dz)) }), [])
    const border = theme === "dark" ? "#444" : "#ccc"
    const btn: React.CSSProperties = {
        width: 26, height: 26, padding: 0, lineHeight: 1, fontSize: 15, cursor: "pointer",
        background: theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)",
        color: theme === "dark" ? "#e0e0e0" : "#333", border: `1px solid ${border}`, borderRadius: 4,
    }
    return (
        <div ref={ref} style={{ position: "relative", height, width: "100%", borderRadius: 4, overflow: "hidden", border: `1px solid ${border}` }}>
            {view && (
                <DeckGL
                    ref={deckRef}
                    onAfterRender={onAfterRender}
                    viewState={{ ...view, pitch: 0, bearing: 0 }}
                    onViewStateChange={({ viewState }: any) => setView({ longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom })}
                    controller={{ scrollZoom: false, dragRotate: false, touchRotate: false, keyboard: false, maxZoom: MAX_ZOOM } as any}
                    layers={layers}
                    onHover={onHover}
                    onClick={onClick}
                    getCursor={({ isDragging }) => (isDragging ? "grabbing" : hovering ? "pointer" : "grab")}
                    style={{ position: "absolute", inset: "0" }}
                >
                    <MapGl ref={mapRef} mapStyle={style} maxZoom={MAX_ZOOM} attributionControl={false} />
                </DeckGL>
            )}
            <div style={{ position: "absolute", top: 8, right: 8, zIndex: 5, display: "flex", flexDirection: "column", gap: 4 }}>
                <button type="button" style={btn} aria-label="Zoom in" onClick={() => zoomBy(1)}>+</button>
                <button type="button" style={btn} aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</button>
                <button type="button" style={{ ...btn, fontSize: 13 }} aria-label="Reset view" onClick={() => setView(home)}>⟲</button>
            </div>
            {children}
            <AttributionPopover theme={theme} />
        </div>
    )
}
