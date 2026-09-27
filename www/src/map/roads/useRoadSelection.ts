import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { PathLayer } from "@deck.gl/layers"
import { useUrlState, stringParam } from "use-prms"
import { useAction } from "use-kbd"
import { useDb } from "@/src/lib/DuckDbContext"
import {
    fetchEntity, fetchEntityCrashes, fetchEntityGeom, fetchHitPoints, hitFileForZoom, HIT_TIERS, nearestRoad,
    roadPaths, roadSegments, type Bbox, type RoadPoint,
} from "./roadsData"

const { cos, PI, pow } = Math

/** Road hover/click works from the widest hit tier's zoom (major roads only out there). */
export const ROAD_HIT_MIN_ZOOM = Math.min(...HIT_TIERS.map(t => t.minZoom))
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

/** Map road selection (specs/road-name-normalization-and-search.md Layer 4b): hover a road to
 *  highlight it, click to select it (`?road=<entity>`); the selection's geometry, summary and
 *  crashes load from the `roads/` parquets. A road is an *entity* (same-named SRI runs joined
 *  across routes), not an SRI. `viewBbox` is the current viewport. */
export function useRoadSelection(view: View | null, viewBbox: Bbox | null) {
    const db = useDb()
    const [roadUrl, setRoadUrl] = useUrlState("road", stringParam())
    const road = roadUrl && /^\d+$/.test(roadUrl) ? Number(roadUrl) : null
    const setRoad = useCallback((entity: number | null) => setRoadUrl(entity === null ? undefined : String(entity)), [setRoadUrl])
    const hitFile = view ? hitFileForZoom(view.zoom) : null
    const active = !!hitFile

    // Hit points for a padded bbox; refetched when the viewport leaves it or the zoom tier changes.
    const [hitKey, setHitKey] = useState<{ file: string; bbox: Bbox } | null>(null)
    useEffect(() => {
        if (!hitFile || !viewBbox) return
        if (hitKey && hitKey.file === hitFile && contains(hitKey.bbox, viewBbox)) return
        const t = setTimeout(() => setHitKey({ file: hitFile, bbox: pad(viewBbox, HIT_PAD) }), 250)
        return () => clearTimeout(t)
    }, [hitFile, viewBbox, hitKey])
    const hit = useQuery({
        queryKey: ["road-hit", hitKey],
        queryFn: () => fetchHitPoints(db!, hitKey!.file as Parameters<typeof fetchHitPoints>[1], hitKey!.bbox),
        enabled: active && !!db && !!hitKey,
    })
    const hitPoints = useMemo(() => (active && hitKey?.file === hitFile ? (hit.data ?? []) : []), [active, hitKey, hitFile, hit.data])
    const hitSegments = useMemo(() => roadSegments(hitPoints), [hitPoints])

    const [hovered, setHovered] = useState<RoadPoint | null>(null)
    const hitMeters = view ? HIT_PX * metersPerPixel(view.zoom, view.latitude) : 0
    const onHover = useCallback((lngLat: [number, number] | null) => {
        setHovered(lngLat && hitSegments.length ? nearestRoad(hitSegments, lngLat, hitMeters) : null)
    }, [hitSegments, hitMeters])
    // A click selects what's highlighted (so a cursor twitch between hover and click can't land on a
    // neighbor); only without a hover does it hit-test the click point itself.
    const onClick = useCallback((lngLat?: [number, number]) => {
        if (!active) return false
        const p = hovered ?? (lngLat ? nearestRoad(hitSegments, lngLat, hitMeters) : null)
        if (p) { setRoad(p.entity); return true }
        return false
    }, [active, hovered, hitSegments, hitMeters, setRoad])

    const enabled = !!db && road !== null
    const info = useQuery({ queryKey: ["road-entity", road], queryFn: () => fetchEntity(db!, road!), enabled })
    const sris = info.data?.sris.split(",") ?? []
    const geom = useQuery({
        queryKey: ["road-geom", road, info.data?.sris],
        queryFn: () => fetchEntityGeom(db!, road!, sris),
        enabled: enabled && sris.length > 0,
    })
    // Waits on the entity's SRIs, which prune `crashes-by-entity` to their row groups.
    const crashes = useQuery({
        queryKey: ["road-crashes", road, info.data?.sris],
        queryFn: () => fetchEntityCrashes(db!, road!, sris),
        enabled: enabled && sris.length > 0,
    })

    useAction("map:road-clear", {
        label: "Clear road selection",
        group: "Map",
        defaultBindings: ["m x"],
        keywords: ["road", "route", "deselect"],
        handler: () => setRoad(null),
    })

    const hoveredEntity = hovered && hovered.entity !== road ? hovered.entity : null
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
        if (hoveredEntity !== null) {
            // White on a dark casing, distinct from the (blue) hovered muni / county outline.
            const paths = roadPaths(hitPoints.filter(p => p.entity === hoveredEntity))
            for (const [id, color, width] of [
                ["road-hover-casing", [0, 0, 0, 170], 7],
                ["road-hover", [255, 255, 255, 240], 3],
            ] as const) {
                out.push(new PathLayer({
                    id,
                    data: paths,
                    getPath: (d: [number, number][]) => d,
                    getColor: [...color],
                    getWidth: width,
                    widthUnits: "pixels",
                    capRounded: true,
                    jointRounded: true,
                }))
            }
        }
        return out
    }, [geom.data, hoveredEntity, hitPoints])

    return {
        road, setRoad, active, hovered, onHover, onClick, layers,
        info: info.data ?? null,
        crashes: crashes.data ?? null,
        loading: info.isFetching || geom.isFetching || crashes.isFetching,
    }
}
