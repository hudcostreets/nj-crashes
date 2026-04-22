/** Reusable interactive crash map.
 *
 * Base: MapLibre GL via react-map-gl/maplibre (raster tiles).
 * Overlay: Deck.gl layers (Scatterplot / Heatmap / Hexbin) with controlled viewState.
 * Nav: right-click / ctrl-drag rotates; two-finger touch drag pitches (mobile).
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Map, Source, Layer } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import DeckGL from "@deck.gl/react/typed"
import { ScatterplotLayer } from "@deck.gl/layers/typed"
import { HeatmapLayer } from "@deck.gl/aggregation-layers/typed"
import type { PickingInfo } from "@deck.gl/core/typed"
import type { FeatureCollection } from "geojson"
import { useTouchPitch } from "./hooks/useTouchPitch"
import { binIntoHexes, hexesToSegments, buildStackedHexLayer, Segment } from "./StackedHexLayer"

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
    crashes: Crash[]
    outline?: FeatureCollection
    initialBounds?: [number, number, number, number]
    initialCenter?: { longitude: number; latitude: number; zoom: number }
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

function fmtDate(d: Date | number): string {
    const date = d instanceof Date ? d : new Date(d)
    return date.toISOString().slice(0, 10)
}

/** Map MapLibre zoom → a reasonable H3 resolution.
 *  Zoom 9  → r7 (big hexes, ~1.2km)
 *  Zoom 11 → r8 (~460m)
 *  Zoom 13 → r9 (~175m)
 *  Zoom 15 → r10 (~65m)
 */
function zoomToH3Resolution(zoom: number): number {
    if (zoom < 10) return 7
    if (zoom < 12) return 8
    if (zoom < 14) return 9
    if (zoom < 16) return 10
    return 11
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
    outline,
    initialBounds,
    initialCenter,
    mode = "scatter",
    theme = "dark",
    height = "100%",
}: Props) {
    const [viewState, setViewState] = useState<ViewState>(() => defaultView(initialBounds, initialCenter, mode))
    const [hoverInfo, setHoverInfo] = useState<PickingInfo | null>(null)
    // H3 hex resolution for hexbin mode. `null` = auto (derived from zoom).
    // Range 6 (big) .. 11 (tiny). Default auto.
    const [hexRes, setHexRes] = useState<number | null>(null)
    const effectiveHexRes = hexRes ?? zoomToH3Resolution(viewState.zoom)
    // Height multiplier (meters per crash)
    const [elevationPerCount, setElevationPerCount] = useState(15)

    // Auto-tilt when switching into hexbin, flatten when leaving
    useEffect(() => {
        setViewState(v => {
            const desired = mode === "hexbin" ? (v.pitch > 0 ? v.pitch : 45) : 0
            return v.pitch === desired ? v : { ...v, pitch: desired }
        })
    }, [mode])

    const isPitchingRef = useTouchPitch({ setViewState, maxPitch: MAX_PITCH })

    const layers = useMemo(() => {
        if (mode === "scatter") {
            return [
                new ScatterplotLayer<Crash>({
                    id: "crashes-scatter",
                    data: crashes,
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
            return [
                new HeatmapLayer<Crash>({
                    id: "crashes-heatmap",
                    data: crashes,
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
        const hexes = binIntoHexes(crashes, effectiveHexRes)
        const segments = hexesToSegments(hexes, elevationPerCount)
        return [
            buildStackedHexLayer({
                id: "crashes-hex-stacked",
                segments,
                resolution: effectiveHexRes,
                pickable: true,
                onHover: (info) => { setHoverInfo(info); return false },
            }),
        ]
    }, [crashes, mode, effectiveHexRes, elevationPerCount])

    const onViewStateChange = useCallback(({ viewState: vs }: any) => {
        if (isPitchingRef.current) return
        const { longitude, latitude, zoom, pitch, bearing } = vs
        setViewState({ longitude, latitude, zoom, pitch, bearing })
    }, [isPitchingRef])

    const style = useMemo(() => rasterStyle(theme), [theme])

    return (
        <div style={{ position: "relative", height, width: "100%" }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={onViewStateChange}
                controller={{ touchRotate: true, dragRotate: true } as any}
                layers={layers}
                style={{ position: "absolute", inset: "0" }}
            >
                <Map mapStyle={style} maxPitch={MAX_PITCH} attributionControl={false}>
                    {outline && (
                        <Source id="outline" type="geojson" data={outline}>
                            <Layer
                                id="outline-line"
                                type="line"
                                paint={{
                                    "line-color": theme === "dark" ? "#6db3f2" : "#0066cc",
                                    "line-width": 1.5,
                                    "line-opacity": 0.8,
                                }}
                            />
                        </Source>
                    )}
                </Map>
            </DeckGL>
            <PitchSlider viewState={viewState} setViewState={setViewState} theme={theme} />
            {mode === "hexbin" && (
                <HexControls
                    hexRes={hexRes}
                    setHexRes={setHexRes}
                    autoHexRes={zoomToH3Resolution(viewState.zoom)}
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
            position: "absolute", top: "3.5em", right: "1em", background: bg, color: fg,
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
    hexRes, setHexRes, autoHexRes, elevationPerCount, setElevationPerCount, theme,
}: {
    hexRes: number | null
    setHexRes: (v: number | null) => void
    autoHexRes: number
    elevationPerCount: number
    setElevationPerCount: (v: number) => void
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const effective = hexRes ?? autoHexRes
    return (
        <div style={{
            position: "absolute", top: "6em", right: "1em", background: bg, color: fg,
            padding: "0.5em 0.7em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em",
            display: "flex", flexDirection: "column", gap: 6, minWidth: 180,
        }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span>Hex size: r{effective}{hexRes === null ? " (auto)" : ""}</span>
                <input
                    type="range" min={6} max={11} step={1}
                    value={effective}
                    onChange={(e) => setHexRes(Number(e.target.value))}
                    style={{ width: 80 }}
                />
            </label>
            {hexRes !== null && (
                <button
                    onClick={() => setHexRes(null)}
                    style={{
                        padding: "0.15em 0.4em",
                        fontSize: "0.75em",
                        cursor: "pointer",
                        background: "transparent",
                        color: fg,
                        border: `1px solid ${fg}`,
                        borderRadius: 3,
                        alignSelf: "flex-start",
                    }}
                >Reset to auto</button>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span>Bar height: {elevationPerCount}×</span>
                <input
                    type="range" min={3} max={60} step={1}
                    value={elevationPerCount}
                    onChange={(e) => setElevationPerCount(Number(e.target.value))}
                    style={{ width: 80 }}
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
        return (
            <div style={tooltipStyle(info)}>
                <div><b>{h.total}</b> injury/fatal crashes in this hex</div>
                <div style={{ color: "rgb(200,40,40)" }}>
                    <b>{h.fatal}</b> fatal
                </div>
                <div style={{ color: "rgb(253,140,60)" }}>
                    <b>{h.pedInj}</b> ped/cyclist injury
                </div>
                <div style={{ color: "rgb(230,220,100)" }}>
                    <b>{h.otherInj}</b> other injury
                </div>
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
