/** Crash detail page's map: the crash as a marker, plus its matched road's path (lazy-loaded). */
import { useMemo } from "react"
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers"
import MiniMap from "./MiniMap"
import { severityRgba, type Severity } from "./basemap"

export type CrashLocationMapProps = {
    lat: number
    lon: number
    severity: string
    /** The crash's road entity, as drawable paths (`roadPaths`). */
    roadPaths?: [number, number][][]
    theme: "light" | "dark"
    height?: number
}

export default function CrashLocationMap({ lat, lon, severity, roadPaths, theme, height = 340 }: CrashLocationMapProps) {
    const sev: Severity = severity === "f" || severity === "i" ? severity : "p"
    const center = useMemo(() => ({ latitude: lat, longitude: lon, zoom: 16 }), [lat, lon])
    const layers = useMemo(() => [
        roadPaths?.length && new PathLayer({
            id: "crash-road",
            data: roadPaths,
            getPath: (d: [number, number][]) => d,
            getColor: [80, 200, 255, 200],
            getWidth: 5,
            widthUnits: "pixels",
            capRounded: true,
            jointRounded: true,
        }),
        new ScatterplotLayer({
            id: "crash-marker",
            data: [{ lon, lat }],
            getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
            getFillColor: severityRgba(sev, 255),
            getLineColor: theme === "dark" ? [255, 255, 255, 255] : [30, 30, 30, 255],
            stroked: true,
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            radiusUnits: "pixels",
            getRadius: 8,
            updateTriggers: { getLineColor: theme },
        }),
    ].filter(Boolean), [roadPaths, lon, lat, sev, theme])
    return <MiniMap height={height} theme={theme} center={center} layers={layers} />
}
