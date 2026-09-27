/** Road page's map: the road's path and its crashes, coloured by severity (lazy-loaded). */
import { useMemo, useState } from "react"
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers"
import type { PickingInfo } from "@deck.gl/core"
import MiniMap, { type Bbox } from "../MiniMap"
import { SEVERITY_COLOR, severityRgba, type Severity } from "../basemap"
import type { RoadCrashView } from "./roadsData"

const SEV_ORDER: Record<string, number> = { p: 0, i: 1, f: 2 }
const SEV_LABEL: Record<Severity, string> = { f: "Fatal", i: "Injury", p: "Property" }

type Located = RoadCrashView & { lat: number; lon: number }

export type RoadMapProps = {
    paths: [number, number][][]
    /** The selected scope's stretch (block / stretch / span), drawn white on a dark casing. */
    highlight?: [number, number][][]
    crashes: RoadCrashView[]
    bounds: Bbox
    theme: "light" | "dark"
    height?: number
    onCrashClick?: (c: RoadCrashView) => void
}

function sevOf(s: string): Severity {
    return s === "f" || s === "i" ? s : "p"
}

export default function RoadMap({ paths, highlight, crashes, bounds, theme, height = 450, onCrashClick }: RoadMapProps) {
    // Fatal drawn last (on top).
    const points = useMemo(
        () => crashes
            .filter((c): c is Located => c.lat !== null && c.lon !== null)
            .sort((a, b) => (SEV_ORDER[a.severity] ?? 0) - (SEV_ORDER[b.severity] ?? 0)),
        [crashes],
    )
    const [hover, setHover] = useState<{ c: Located; x: number; y: number } | null>(null)
    const layers = useMemo(() => [
        new PathLayer({
            id: "road-path",
            data: paths,
            getPath: (d: [number, number][]) => d,
            getColor: [80, 200, 255, 160],
            getWidth: 5,
            widthUnits: "pixels",
            capRounded: true,
            jointRounded: true,
        }),
        ...(highlight?.length
            ? ([["road-scope-casing", [0, 0, 0, 190], 9], ["road-scope", [255, 255, 255, 245], 4]] as const).map(([id, color, width]) =>
                new PathLayer({
                    id,
                    data: highlight,
                    getPath: (d: [number, number][]) => d,
                    getColor: [...color],
                    getWidth: width,
                    widthUnits: "pixels",
                    capRounded: true,
                    jointRounded: true,
                }))
            : []),
        new ScatterplotLayer<Located>({
            id: "road-crashes",
            data: points,
            getPosition: d => [d.lon, d.lat],
            getFillColor: d => severityRgba(sevOf(d.severity), d.severity === "p" ? 150 : 220),
            radiusUnits: "pixels",
            getRadius: d => (d.severity === "f" ? 4 : 3),
            pickable: true,
        }),
    ], [paths, highlight, points])
    const onHover = (info: PickingInfo) => setHover(info.object ? { c: info.object as Located, x: info.x, y: info.y } : null)
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    return (
        <MiniMap
            height={height}
            theme={theme}
            bounds={bounds}
            layers={layers}
            onHover={onHover}
            onClick={info => { if (info.object && onCrashClick) onCrashClick(info.object as RoadCrashView) }}
            hovering={!!hover}
        >
            {hover && (
                <div style={{
                    position: "absolute", left: hover.x + 12, top: hover.y + 12, zIndex: 6, pointerEvents: "none",
                    background: bg, color: fg, padding: "4px 8px", borderRadius: 4, fontSize: 12,
                    boxShadow: "0 1px 4px rgba(0,0,0,0.4)", whiteSpace: "nowrap",
                }}>
                    <b>{new Date(hover.c.dt).toISOString().slice(0, 10)}</b> · {SEV_LABEL[sevOf(hover.c.severity)]}
                    {(hover.c.tk || hover.c.ti) ? <> · {hover.c.tk ?? 0} killed / {hover.c.ti ?? 0} injured</> : null}
                    {hover.c.cross_street && <div>at {hover.c.cross_street}</div>}
                    <div style={{ opacity: 0.7 }}>click for details</div>
                </div>
            )}
            <div style={{
                position: "absolute", right: 8, bottom: 8, zIndex: 5, display: "flex", gap: 8,
                background: bg, color: fg, padding: "2px 8px", borderRadius: 4, fontSize: 11,
            }}>
                {(["f", "i", "p"] as const).map(s => (
                    <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: `rgb(${SEVERITY_COLOR[s].join(",")})` }} />
                        {SEV_LABEL[s]}
                    </span>
                ))}
            </div>
        </MiniMap>
    )
}
