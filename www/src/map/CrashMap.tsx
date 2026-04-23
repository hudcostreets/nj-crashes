/** Reusable interactive crash map.
 *
 * Base: MapLibre GL via react-map-gl/maplibre (raster tiles).
 * Overlay: Deck.gl layers (Scatterplot / Heatmap / Hexbin) with controlled viewState.
 * Nav: right-click / ctrl-drag rotates; two-finger touch drag pitches (mobile).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Map, type MapRef } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import DeckGL from "@deck.gl/react/typed"
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers/typed"
import { HeatmapLayer } from "@deck.gl/aggregation-layers/typed"
import type { PickingInfo } from "@deck.gl/core/typed"
import type { FeatureCollection } from "geojson"
import { useTouchPitch } from "./hooks/useTouchPitch"
import { binIntoHexes, hexesToSegments, buildStackedHexLayer, Segment, StackedHex, H3_RADIUS_METERS } from "./StackedHexLayer"

export type MapMode = "scatter" | "heatmap" | "hexbin"

export type Crash = {
    dt: Date | number
    severity: "i" | "f"
    lon: number
    lat: number
    tk: number
    ti: number
    pk: number
    pi: number
    tv: number
    city?: string
    sri?: string
    mp?: number
}

export type ViewState = {
    longitude: number
    latitude: number
    zoom: number
    pitch: number
    bearing: number
}

export type Props = {
    /** Raw crash-level data, used in scatter/heatmap and to derive
     *  client-side hex aggregates in hexbin mode when `prebinnedHexes`
     *  is not provided. */
    crashes?: Crash[]
    /** Pre-aggregated hex cells (from a server-side parquet aggregate).
     *  When provided AND `mode=hexbin`, these are rendered directly,
     *  skipping the client-side binning. */
    prebinnedHexes?: StackedHex[]
    outline?: FeatureCollection
    initialBounds?: [number, number, number, number]
    initialCenter?: { longitude: number; latitude: number; zoom: number }
    /** Controlled viewState (use when caller owns URL/state sync). When
     *  omitted, `CrashMap` manages its own internal state derived from
     *  `initialBounds`/`initialCenter`. */
    viewState?: ViewState
    onViewStateChange?: (v: ViewState) => void
    /** Controlled hex pixel target (pairs with `onHexPxTargetChange`). */
    hexPxTarget?: number
    onHexPxTargetChange?: (n: number) => void
    /** Controlled bar height multiplier (hexbin only). */
    elevationPerCount?: number
    onElevationPerCountChange?: (n: number) => void
    /** Click handler for outline polygons (geo drill-down). */
    onOutlineClick?: (feature: any) => void
    /** Render the internal PitchSlider / HexControls corner widgets.
     *  Caller can disable (when it supplies its own consolidated panel). */
    showInternalControls?: boolean
    mode?: MapMode
    theme?: "light" | "dark"
    height?: number | string
}

const MAX_PITCH = 85

const STADIA_ATTRIBUTION = '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

function rasterStyle(theme: "light" | "dark"): any {
    const slug = theme === "dark" ? "alidade_smooth_dark" : "alidade_smooth"
    return {
        version: 8,
        sources: {
            stadia: {
                type: "raster",
                tiles: [`https://tiles.stadiamaps.com/tiles/${slug}/{z}/{x}/{y}@2x.png`],
                tileSize: 256,
                attribution: STADIA_ATTRIBUTION,
            },
        },
        layers: [{ id: "stadia", type: "raster", source: "stadia" }],
    }
}

const SEVERITY_COLOR: Record<Crash["severity"], [number, number, number]> = {
    f: [239, 68, 68],
    i: [245, 158, 11],
}

function severityRgba(sev: Crash["severity"], alpha = 200): [number, number, number, number] {
    const [r, g, b] = SEVERITY_COLOR[sev]
    return [r, g, b, alpha]
}

/** Web-mercator meters-per-pixel at given zoom + latitude. */
function metersPerPixel(zoom: number, lat: number): number {
    return 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom)
}

/** Pick integer H3 resolution whose cell-edge length in meters is closest
 *  to the desired pixel-radius at the current zoom+latitude. Comparison on
 *  a log2 scale so ±1 resolution is one constant step of coarseness. */
function pickHexResolutionForPixels(pixelTarget: number, zoom: number, lat: number): number {
    const targetMeters = pixelTarget * metersPerPixel(zoom, lat)
    let best = 9, bestDiff = Infinity
    for (const rStr of Object.keys(H3_RADIUS_METERS)) {
        const r = Number(rStr)
        const edge = H3_RADIUS_METERS[r]
        const diff = Math.abs(Math.log2(edge / targetMeters))
        if (diff < bestDiff) { bestDiff = diff; best = r }
    }
    return best
}

function fmtDate(d: Date | number): string {
    const date = d instanceof Date ? d : new Date(d)
    return date.toISOString().slice(0, 10)
}


/** Web-mercator fit: zoom where `[w,s,e,n]` fits inside (containerW×containerH)
 *  pixels at the bounds' center latitude. Matches `maplibregl.Map.cameraForBounds`. */
export function fitBoundsToView(
    bounds: [number, number, number, number],
    containerW: number,
    containerH: number,
    pitch = 0,
    padPx = 40,
): ViewState {
    const [w, s, e, n] = bounds
    const lat = (s + n) / 2
    const lon = (w + e) / 2
    const cw = Math.max(50, containerW - padPx * 2)
    const ch = Math.max(50, containerH - padPx * 2)
    const COS = Math.cos(lat * Math.PI / 180)
    const metersPerDegLon = 111_320 * COS
    const metersPerDegLat = 110_574
    const lateralM = Math.max(1, (e - w) * metersPerDegLon)
    const verticalM = Math.max(1, (n - s) * metersPerDegLat)
    const mppNeeded = Math.max(lateralM / cw, verticalM / ch)
    const zoom = Math.log2(156543.03 * COS / mppNeeded)
    return { latitude: lat, longitude: lon, zoom: Math.max(7, Math.min(18, zoom)), pitch, bearing: 0 }
}

function defaultView(
    initialBounds: Props["initialBounds"],
    initialCenter: Props["initialCenter"],
    mode: MapMode,
): ViewState {
    const pitch = mode === "hexbin" ? 45 : 0
    if (initialBounds) {
        const [w, s, e, n] = initialBounds
        return { longitude: (w + e) / 2, latitude: (s + n) / 2, zoom: 11, pitch, bearing: 0 }
    }
    return { ...(initialCenter ?? { longitude: -74.08, latitude: 40.73, zoom: 11 }), pitch, bearing: 0 }
}

export function CrashMap({
    crashes,
    prebinnedHexes,
    outline,
    initialBounds,
    initialCenter,
    viewState: controlledView,
    onViewStateChange: onControlledChange,
    hexPxTarget: controlledHexPxTarget,
    onHexPxTargetChange,
    elevationPerCount: controlledElevation,
    onElevationPerCountChange,
    onOutlineClick,
    showInternalControls = true,
    mode = "scatter",
    theme = "dark",
    height = "100%",
}: Props) {
    const effectiveCrashes = crashes ?? []
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const [localViewState, setLocalViewState] = useState<ViewState>(() => defaultView(initialBounds, initialCenter, mode))
    const viewState = controlledView ?? localViewState
    // Auto-fit bounds when uncontrolled: re-run whenever `initialBounds` change
    // AND the container has a measurable size. Caller-owned `controlledView`
    // skips this (CrashMapPage does its own `fitBoundsToView`).
    const fitKeyRef = React.useRef<string>("")
    useEffect(() => {
        if (controlledView !== undefined || !initialBounds) return
        const el = containerRef.current
        if (!el) return
        const { clientWidth: cw, clientHeight: ch } = el
        if (!cw || !ch) return
        const key = `${initialBounds.join(",")}-${cw}x${ch}-${mode}`
        if (key === fitKeyRef.current) return
        fitKeyRef.current = key
        setLocalViewState(fitBoundsToView(initialBounds, cw, ch, mode === "hexbin" ? 45 : 0))
    }, [initialBounds, controlledView, mode])
    const setViewState: React.Dispatch<React.SetStateAction<ViewState>> = useCallback((updater) => {
        if (controlledView !== undefined && onControlledChange) {
            const next = typeof updater === "function" ? (updater as (v: ViewState) => ViewState)(controlledView) : updater
            onControlledChange(next)
        } else {
            setLocalViewState(updater)
        }
    }, [controlledView, onControlledChange])
    const [hoverInfo, setHoverInfo] = useState<PickingInfo | null>(null)
    // Target on-screen hex radius in pixels. Auto-picks the H3 resolution
    // whose edge length at the current zoom+latitude is closest to this
    // target, so hexes stay ~constant size as you zoom (and don't jitter
    // as you pan at a constant zoom — the choice depends only on zoom/lat,
    // not on which points are visible).
    const [localHexPxTarget, setLocalHexPxTarget] = useState(1.8)
    const hexPxTarget = controlledHexPxTarget ?? localHexPxTarget
    const setHexPxTarget = useCallback((n: number) => {
        if (controlledHexPxTarget !== undefined && onHexPxTargetChange) onHexPxTargetChange(n)
        else setLocalHexPxTarget(n)
    }, [controlledHexPxTarget, onHexPxTargetChange])
    const mapRef = React.useRef<MapRef | null>(null)
    // Height multiplier (meters per crash)
    const [localElevation, setLocalElevation] = useState(15)
    const elevationPerCount = controlledElevation ?? localElevation
    const setElevationPerCount = useCallback((n: number) => {
        if (controlledElevation !== undefined && onElevationPerCountChange) onElevationPerCountChange(n)
        else setLocalElevation(n)
    }, [controlledElevation, onElevationPerCountChange])

    // Auto-tilt when switching into hexbin, flatten when leaving
    useEffect(() => {
        setViewState(v => {
            const desired = mode === "hexbin" ? (v.pitch > 0 ? v.pitch : 45) : 0
            return v.pitch === desired ? v : { ...v, pitch: desired }
        })
    }, [mode])

    const isPitchingRef = useTouchPitch({ setViewState, maxPitch: MAX_PITCH })

    // H3 resolution picked from pixel target + current zoom+latitude.
    // Purely derived — no data binning, no viewport filter → pan is stable.
    const effectiveHexRes = useMemo(
        () => pickHexResolutionForPixels(hexPxTarget, viewState.zoom, viewState.latitude),
        [hexPxTarget, viewState.zoom, viewState.latitude],
    )

    const outlineLayer = useMemo(() => {
        if (!outline) return null
        const lineRgb: [number, number, number] = theme === "dark" ? [109, 179, 242] : [0, 102, 204]
        return new GeoJsonLayer({
            id: "outline",
            data: outline,
            // Transparent fill (only visible via picking; visible tint when clickable).
            getFillColor: onOutlineClick ? [...lineRgb, 12] as any : [0, 0, 0, 0] as any,
            getLineColor: [...lineRgb, 204] as any,
            lineWidthMinPixels: 1.5,
            pickable: !!onOutlineClick,
            onClick: onOutlineClick ? (info) => {
                if (info.object) { onOutlineClick(info.object); return true }
                return false
            } : undefined,
            updateTriggers: {
                getFillColor: [theme, !!onOutlineClick],
                getLineColor: [theme],
            },
        })
    }, [outline, theme, onOutlineClick])

    const layers = useMemo(() => {
        const base: any[] = outlineLayer ? [outlineLayer] : []
        if (mode === "scatter") {
            return [...base,
                new ScatterplotLayer<Crash>({
                    id: "crashes-scatter",
                    data: effectiveCrashes,
                    getPosition: (c) => [c.lon, c.lat],
                    getFillColor: (c) => severityRgba(c.severity, 200),
                    getRadius: (c) => 4 + Math.min(c.tk * 4 + c.ti, 20),
                    radiusUnits: "meters",
                    radiusMinPixels: 3,
                    radiusMaxPixels: 20,
                    stroked: true,
                    lineWidthMinPixels: 0.5,
                    getLineColor: [0, 0, 0, 80],
                    pickable: true,
                    onHover: (info) => { setHoverInfo(info); return false },
                }),
            ]
        }
        if (mode === "heatmap") {
            return [...base,
                new HeatmapLayer<Crash>({
                    id: "crashes-heatmap",
                    data: effectiveCrashes,
                    getPosition: (c) => [c.lon, c.lat],
                    getWeight: (c) => (c.severity === "f" ? 5 : 1) + c.tk * 3 + c.ti,
                    radiusPixels: 30,
                    intensity: 1.0,
                    threshold: 0.04,
                }),
            ]
        }
        // Hexbin: bin crashes into H3 cells; per-cell render a stacked
        // 3-segment column — bottom = other injuries (yellow), middle = ped/
        // cyclist injuries (orange), top = fatal (red). Height encodes total
        // count; color encodes severity breakdown within the stack.
        // Pick the finest resolution that produces ≤ `maxHexes` hexes; bin
        // inline (single pass at each candidate resolution; stop when size
        // limit exceeded).
        const hexes = prebinnedHexes ?? binIntoHexes(effectiveCrashes, effectiveHexRes)
        const segments = hexesToSegments(hexes, elevationPerCount)
        return [...base,
            buildStackedHexLayer({
                id: "crashes-hex-stacked",
                segments,
                resolution: effectiveHexRes,
                pickable: true,
                onHover: (info) => { setHoverInfo(info); return false },
            }),
        ]
    }, [effectiveCrashes, prebinnedHexes, mode, effectiveHexRes, elevationPerCount, outlineLayer])

    const onViewStateChange = useCallback(({ viewState: vs }: any) => {
        if (isPitchingRef.current) return
        const { longitude, latitude, zoom, pitch, bearing } = vs
        setViewState({ longitude, latitude, zoom, pitch, bearing })
    }, [isPitchingRef])

    const style = useMemo(() => rasterStyle(theme), [theme])

    return (
        <div ref={containerRef} style={{ position: "relative", height, width: "100%" }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={onViewStateChange}
                controller={{ touchRotate: true, dragRotate: true, maxPitch: MAX_PITCH } as any}
                layers={layers}
                style={{ position: "absolute", inset: "0" }}
            >
                <Map
                    ref={mapRef}
                    mapStyle={style}
                    maxPitch={MAX_PITCH}
                    attributionControl={false}
                    onLoad={() => {
                        const map = mapRef.current?.getMap()
                        if (!map || !initialBounds || controlledView) return
                        map.fitBounds(
                            [[initialBounds[0], initialBounds[1]], [initialBounds[2], initialBounds[3]]],
                            { padding: 20, animate: false },
                        )
                    }}
                />
            </DeckGL>
            {showInternalControls && <PitchSlider viewState={viewState} setViewState={setViewState} theme={theme} />}
            {showInternalControls && mode === "hexbin" && (
                <HexControls
                    effectiveRes={effectiveHexRes}
                    pixelTarget={hexPxTarget}
                    setPixelTarget={setHexPxTarget}
                    elevationPerCount={elevationPerCount}
                    setElevationPerCount={setElevationPerCount}
                    theme={theme}
                />
            )}
            {hoverInfo?.object && mode !== "heatmap" && <CrashTooltip info={hoverInfo} />}
        </div>
    )
}

function PitchSlider({
    viewState, setViewState, theme,
}: {
    viewState: ViewState
    setViewState: React.Dispatch<React.SetStateAction<ViewState>>
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    return (
        <div style={{
            position: "absolute", top: "1em", left: "1em", background: bg, color: fg,
            padding: "0.4em 0.7em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em",
            display: "flex", alignItems: "center", gap: 8,
        }}>
            <span>Pitch: {Math.round(viewState.pitch)}°</span>
            <input
                type="range"
                min={0}
                max={MAX_PITCH}
                value={viewState.pitch}
                onChange={(e) => setViewState(v => ({ ...v, pitch: Number(e.target.value) }))}
                style={{ width: 100 }}
            />
        </div>
    )
}

function HexControls({
    effectiveRes, pixelTarget, setPixelTarget, elevationPerCount, setElevationPerCount, theme,
}: {
    effectiveRes: number
    pixelTarget: number
    setPixelTarget: (v: number) => void
    elevationPerCount: number
    setElevationPerCount: (v: number) => void
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    return (
        <div style={{
            position: "absolute", top: "3.5em", left: "1em", background: bg, color: fg,
            padding: "0.5em 0.7em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em",
            display: "flex", flexDirection: "column", gap: 6, minWidth: 210,
        }}>
            {(() => {
                // Log slider: each H3 resolution jump is ~log2(2.65) ≈ 1.4 units,
                // so uniform log-px coverage gives even stops through r5…r13.
                // slider value ∈ [0, 100]; higher = higher density = smaller hexes.
                //   0   → 60px (coarse, big hexes)
                //   100 → 1px (dense, one-per-point)
                const sliderValue = Math.round(100 * (1 - Math.log2(pixelTarget) / Math.log2(60)))
                return (
                    <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                        <span>Hex density: {sliderValue} (~{pixelTarget.toFixed(pixelTarget < 5 ? 1 : 0)}px, r{effectiveRes})</span>
                        <input
                            type="range" min={0} max={100} step={1}
                            value={sliderValue}
                            onChange={(e) => {
                                const v = Number(e.target.value)
                                // Inverse of the encoding above:
                                const px = Math.pow(60, 1 - v / 100)
                                // Round to a pleasant tick for the label (0.1 below 5px, integer above)
                                const rounded = px < 5 ? Math.round(px * 10) / 10 : Math.round(px)
                                setPixelTarget(Math.max(0.5, rounded))
                            }}
                            style={{ width: 100 }}
                        />
                    </label>
                )
            })()}
            <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span>Bar height: {elevationPerCount}×</span>
                <input
                    type="range" min={3} max={60} step={1}
                    value={elevationPerCount}
                    onChange={(e) => setElevationPerCount(Number(e.target.value))}
                    style={{ width: 90 }}
                />
            </label>
        </div>
    )
}

function tooltipStyle(info: PickingInfo): React.CSSProperties {
    return {
        position: "absolute",
        left: info.x + 10,
        top: info.y + 10,
        background: "rgba(20,20,20,0.95)",
        color: "#eee",
        padding: "0.5em 0.75em",
        borderRadius: 4,
        pointerEvents: "none",
        fontSize: "0.85em",
        zIndex: 10,
        maxWidth: 280,
    }
}

function CrashTooltip({ info }: { info: PickingInfo }) {
    const obj = info.object
    if (!obj) return null
    const isHex = Array.isArray(obj.points)
    const isStackedSegment = !!obj && "hex" in obj && "tier" in obj
    if (isStackedSegment) {
        const seg = obj as Segment
        const h = seg.hex
        const injury = h.pedInj + h.otherInj
        return (
            <div style={tooltipStyle(info)}>
                <div><b>{h.total}</b> crashes in this hex</div>
                {h.fatal > 0 && (
                    <div style={{ color: "rgb(210,28,28)" }}>
                        <b>{h.fatal}</b> fatal
                    </div>
                )}
                {injury > 0 && (
                    <div style={{ color: "rgb(245,158,11)" }}>
                        <b>{injury}</b> injury{h.pedInj > 0 ? ` (incl. ${h.pedInj} ped/cyclist)` : ""}
                    </div>
                )}
                {h.pdo > 0 && (
                    <div style={{ color: "rgb(220,200,90)" }}>
                        <b>{h.pdo}</b> property damage
                    </div>
                )}
            </div>
        )
    }
    return (
        <div style={tooltipStyle(info)}>
            {isHex ? (
                <>
                    <div><b>{obj.points.length}</b> crashes</div>
                    {(() => {
                        let tk = 0, ti = 0
                        for (const p of obj.points) {
                            const src = (p.source ?? p) as Crash
                            tk += src.tk || 0
                            ti += src.ti || 0
                        }
                        return <div>{tk} killed · {ti} injured</div>
                    })()}
                </>
            ) : (
                <>
                    <div><b>{obj.severity === "f" ? "Fatal" : "Injury"}</b> · {fmtDate(obj.dt)}</div>
                    <div>{obj.tk} killed · {obj.ti} injured · {obj.tv} vehicles</div>
                    {(obj.pk > 0 || obj.pi > 0) && (
                        <div>Pedestrians: {obj.pk} killed, {obj.pi} injured</div>
                    )}
                    {obj.city && <div>{obj.city}</div>}
                    {obj.sri && obj.mp != null && <div>SRI {obj.sri} · MP {obj.mp.toFixed(2)}</div>}
                </>
            )}
        </div>
    )
}
