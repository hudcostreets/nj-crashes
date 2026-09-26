import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { PathLayer } from "@deck.gl/layers"
import { useUrlState, stringParam } from "use-prms"
import { useAction } from "use-kbd"
import { useDb } from "@/src/lib/DuckDbContext"
import {
    fetchHitPoints, fetchRoadCrashes, fetchRoadGeom, fetchRoadInfo, nearestRoad, roadPaths, roadSegments,
    type Bbox, type RoadPoint,
} from "./roadsData"

const { cos, PI, pow } = Math

/** Hover/click select roads only at street-ish zooms (the viewport's hit points stay small). */
export const ROAD_HIT_MIN_ZOOM = 12
/** Hit radius in CSS px. */
const HIT_PX = 10
/** Fetch hit points for a bbox this much larger than the viewport, so small pans reuse them. */
const HIT_PAD = 0.3

type View = { longitude: number; latitude: number; zoom: number }

const metersPerPixel = (zoom: number, lat: number) => 156543.03 * cos(lat * PI / 180) / pow(2, zoom)

function pad([w, s, e, n]: Bbox, f: number): Bbox {
    const dx = (e - w) * f, dy = (n - s) * f
    return [w - dx, s - dy, e + dx, n + dy]
}

function contains([w, s, e, n]: Bbox, [w2, s2, e2, n2]: Bbox): boolean {
    return w <= w2 && s <= s2 && e >= e2 && n >= n2
}

/** Map road selection (specs/road-name-normalization-and-search.md Layer 4b, phase 1): hover a
 *  road to highlight it, click to select (`?road=<sri>`); the selection's geometry, summary and
 *  crashes load from the `roads/` parquets. `viewBbox` is the current viewport. */
export function useRoadSelection(view: View | null, viewBbox: Bbox | null) {
    const db = useDb()
    const [road, setRoadUrl] = useUrlState("road", stringParam())
    const setRoad = useCallback((sri: string | null) => setRoadUrl(sri ?? undefined), [setRoadUrl])
    const active = !!view && view.zoom >= ROAD_HIT_MIN_ZOOM

    // Hit points for a padded bbox; refetched only when the viewport leaves it.
    const [hitBbox, setHitBbox] = useState<Bbox | null>(null)
    useEffect(() => {
        if (!active || !viewBbox) return
        if (hitBbox && contains(hitBbox, viewBbox)) return
        const t = setTimeout(() => setHitBbox(pad(viewBbox, HIT_PAD)), 250)
        return () => clearTimeout(t)
    }, [active, viewBbox, hitBbox])
    const hit = useQuery({
        queryKey: ["road-hit", hitBbox],
        queryFn: () => fetchHitPoints(db!, hitBbox!),
        enabled: active && !!db && !!hitBbox,
    })
    const hitPoints = useMemo(() => (active ? (hit.data ?? []) : []), [active, hit.data])
    const hitSegments = useMemo(() => roadSegments(hitPoints), [hitPoints])

    const [hovered, setHovered] = useState<RoadPoint | null>(null)
    const hitMeters = view ? HIT_PX * metersPerPixel(view.zoom, view.latitude) : 0
    const onHover = useCallback((lngLat: [number, number] | null) => {
        setHovered(lngLat && hitSegments.length ? nearestRoad(hitSegments, lngLat, hitMeters) : null)
    }, [hitSegments, hitMeters])
    /** Returns true if the click selected (or cleared) a road. */
    const onClick = useCallback((lngLat?: [number, number]) => {
        if (!active || !lngLat) return false
        const p = nearestRoad(hitSegments, lngLat, hitMeters)
        if (p) { setRoad(p.sri); return true }
        return false
    }, [active, hitSegments, hitMeters, setRoad])

    const enabled = !!db && !!road
    const geom = useQuery({ queryKey: ["road-geom", road], queryFn: () => fetchRoadGeom(db!, road!), enabled })
    const info = useQuery({ queryKey: ["road-info", road], queryFn: () => fetchRoadInfo(db!, road!), enabled })
    const crashes = useQuery({ queryKey: ["road-crashes", road], queryFn: () => fetchRoadCrashes(db!, road!), enabled })

    useAction("map:road-clear", {
        label: "Clear road selection",
        group: "Map",
        defaultBindings: ["m x"],
        keywords: ["road", "route", "deselect"],
        enabled: !!road,
        handler: () => setRoad(null),
    })

    const hoveredSri = hovered && hovered.sri !== road ? hovered.sri : null
    const layers = useMemo(() => {
        const out: PathLayer[] = []
        if (geom.data?.length) {
            out.push(new PathLayer({
                id: "road-selected",
                data: roadPaths(geom.data),
                getPath: (d: [number, number][]) => d,
                getColor: [80, 200, 255, 230],
                getWidth: 5,
                widthUnits: "pixels",
                capRounded: true,
                jointRounded: true,
            }))
        }
        if (hoveredSri) {
            out.push(new PathLayer({
                id: "road-hover",
                data: roadPaths(hitPoints.filter(p => p.sri === hoveredSri)),
                getPath: (d: [number, number][]) => d,
                getColor: [255, 255, 255, 170],
                getWidth: 3,
                widthUnits: "pixels",
                capRounded: true,
                jointRounded: true,
            }))
        }
        return out
    }, [geom.data, hoveredSri, hitPoints])

    return {
        road, setRoad, active, hovered, onHover, onClick, layers,
        info: info.data ?? null,
        crashes: crashes.data ?? null,
        loading: geom.isFetching || info.isFetching || crashes.isFetching,
    }
}
