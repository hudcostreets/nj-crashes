import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers"
import type { Layer, PickingInfo } from "@deck.gl/core"
import { useUrlState, stringParam } from "use-prms"
import { useAction } from "@/src/lib/kbd"
import {
    fetchEntityGeom, fetchEntitySummary, fetchHitPoints, hitFileForZoom, HIT_TIERS, nearestRoad,
    prefetchEntities, roadPaths, roadSegments, sameRoad, type Bbox, type RoadPoint,
} from "./roadsData"
import { encodeSpan, spanPaths } from "./roadScope"
import { parseRoadRef, useRoadEntity } from "./useRoadEntity"
import { useRoadScope } from "./useRoadScope"

const { cos, PI, pow } = Math

/** Road hover/click works from the widest hit tier's zoom (major roads only out there). */
export const ROAD_HIT_MIN_ZOOM = Math.min(...HIT_TIERS.map(t => t.minZoom))
/** Hit radius in CSS px. */
const HIT_PX = 10
/** Fetch hit points for a bbox this much larger than the viewport, so small pans reuse them. */
const HIT_PAD = 0.3
/** Alt+wheel: one scope step per this much accumulated `deltaY` (a mouse notch is ~100; a
 *  trackpad sends many small deltas), and at most one step per `WHEEL_STEP_MS`. */
const WHEEL_STEP_DELTA = 60
const WHEEL_STEP_MS = 180

type View = { longitude: number; latitude: number; zoom: number }

const metersPerPixel = (zoom: number, lat: number) => 156543.03 * cos(lat * PI / 180) / pow(2, zoom)

function pad([w, s, e, n]: Bbox, f: number): Bbox {
    const dx = (e - w) * f, dy = (n - s) * f
    return [w - dx, s - dy, e + dx, n + dy]
}

function contains([w, s, e, n]: Bbox, [w2, s2, e2, n2]: Bbox): boolean {
    return w <= w2 && s <= s2 && e >= e2 && n >= n2
}

/** Casing + white, the hover style: the selected scope's stretch of road. */
function highlightLayers(id: string, paths: [number, number][][], widths: [number, number]): PathLayer[] {
    return ([
        [`${id}-casing`, [0, 0, 0, 190], widths[0]],
        [id, [255, 255, 255, 245], widths[1]],
    ] as const).map(([lid, color, width]) => new PathLayer({
        id: lid,
        data: paths,
        getPath: (d: [number, number][]) => d,
        getColor: [...color],
        getWidth: width,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
    }))
}

type Handle = { end: 0 | 1; lngLat: [number, number] }

/** Map road selection (specs/road-data-v4.md): hover a road to highlight it, click to select it
 *  (`?road=<slug>`); the selection's geometry, summary and crashes load from the `roads/` parquets.
 *  A road is an *entity* (same-named SRI runs joined across routes), not an SRI. `viewBbox` is the
 *  current viewport. A numeric `?road=<entity>` (a click, or an old link) is rewritten to the slug
 *  once the entity loads. On v5 data, a selected road has a scope (`useRoadScope`): click it to
 *  move the anchor, shift-click to select a span, Alt+wheel / `[` `]` to step the scope ladder,
 *  and drag the span's end handles. */
export function useRoadSelection(view: View | null, viewBbox: Bbox | null) {
    const [roadUrl, setRoadUrl] = useUrlState("road", stringParam())
    const ref = parseRoadRef(roadUrl)
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
        queryFn: () => fetchHitPoints(hitKey!.file as Parameters<typeof fetchHitPoints>[0], hitKey!.bbox),
        enabled: active && !!hitKey,
    })
    const hitPoints = useMemo(() => (active && hitKey?.file === hitFile ? (hit.data ?? []) : []), [active, hitKey, hitFile, hit.data])
    const hitSegments = useMemo(() => roadSegments(hitPoints), [hitPoints])

    const info = useRoadEntity(ref)
    useEffect(() => {
        if (typeof ref === "number" && info.data) setRoadUrl(info.data.slug)
    }, [ref, info.data, setRoadUrl])
    // A click's (numeric) ref is the entity, so its geometry etc. load alongside the entity row.
    const road = typeof ref === "number" ? ref : info.data?.entity ?? null
    const enabled = road !== null
    const geom = useQuery({ queryKey: ["road-geom", road], queryFn: () => fetchEntityGeom(road!), enabled, staleTime: Infinity })
    const summary = useQuery({ queryKey: ["road-summary", road], queryFn: () => fetchEntitySummary(road!, false), enabled, staleTime: Infinity })
    // The scope's road: only once the entity row matches the selection (not a previous road's).
    const scopeInfo = info.data && info.data.entity === road ? info.data : null
    const scope = useRoadScope({ info: scopeInfo, geom: geom.data ?? null, roadSummary: summary.data ?? null, hotkeys: true })

    /** Select a road by slug, or by (this build's) entity id; resets the scope to the whole road. */
    const { clear: clearScope } = scope
    const setRoad = useCallback((r: string | number | null) => {
        clearScope()
        setRoadUrl(r === null ? undefined : String(r))
    }, [setRoadUrl, clearScope])

    // Warm the entity cache for the roads in view, so hover summaries show without a read.
    useEffect(() => {
        if (!hitPoints.length) return
        const t = setTimeout(() => { prefetchEntities(hitPoints.map(p => p.entity)).catch(() => {}) }, 300)
        return () => clearTimeout(t)
    }, [hitPoints])

    const [hovered, setHovered] = useState<RoadPoint | null>(null)
    const hitMeters = view ? HIT_PX * metersPerPixel(view.zoom, view.latitude) : 0
    // Keep the previous point while the cursor stays on the same road, so moving along a road
    // doesn't re-render the map.
    const onHover = useCallback((lngLat: [number, number] | null) => {
        const p = lngLat && hitSegments.length ? nearestRoad(hitSegments, lngLat, hitMeters) : null
        setHovered(prev => (sameRoad(prev, p) ? prev : p))
    }, [hitSegments, hitMeters])
    const memberIds = useMemo(() => new Set(scope.corridorMembers.map(m => m.entity)), [scope.corridorMembers])
    // A click selects what's highlighted (so a cursor twitch between hover and click can't land on a
    // neighbor); only without a hover does it hit-test the click point itself. A click on the
    // selected road (or its corridor, in corridor scope) moves the scope's anchor; shift-click
    // selects the span from the anchor to it (shift-click wins over a cross street under the cursor).
    const onClick = useCallback((lngLat?: [number, number], mods?: { shiftKey?: boolean }) => {
        if (!active) return false
        const shift = !!mods?.shiftKey
        const p = hovered ?? (lngLat ? nearestRoad(hitSegments, lngLat, hitMeters) : null)
        const onSelected = !!p && (p.entity === road || (scope.state.corridor && memberIds.has(p.entity)))
        if (lngLat && road !== null && (onSelected || shift || !p)) {
            if (scope.onRoadClick(lngLat, shift, hitMeters * 1.5)) return true
        }
        if (p && !onSelected) {
            setRoad(p.entity)
            if (lngLat) scope.anchorOnLoad(p.entity, lngLat)
            return true
        }
        return !!p
    }, [active, hovered, hitSegments, hitMeters, road, scope, memberIds, setRoad])

    // Alt+wheel over the map steps the scope ladder (wheel up / away: narrower, like zooming in).
    const wheelAcc = useRef({ delta: 0, lastEvent: 0, lastStep: 0 })
    const { step, v5 } = scope
    const onWheel = useCallback((e: WheelEvent): boolean => {
        if (!e.altKey || road === null || !v5) return false
        const acc = wheelAcc.current
        const now = performance.now()
        if (now - acc.lastEvent > 300) acc.delta = 0
        acc.lastEvent = now
        acc.delta += e.deltaY
        if (Math.abs(acc.delta) >= WHEEL_STEP_DELTA && now - acc.lastStep >= WHEEL_STEP_MS) {
            step(acc.delta < 0 ? -1 : 1)
            acc.delta = 0
            acc.lastStep = now
        }
        return true
    }, [road, v5, step])

    useAction("map:road-clear", {
        label: "Clear road selection",
        group: "Map",
        defaultBindings: ["m x"],
        keywords: ["road", "route", "deselect"],
        handler: () => setRoad(null),
    })

    // Span end handles: hovering one pauses map panning (so the drag moves the handle).
    const [handleHover, setHandleHover] = useState(false)
    const dragRef = useRef<0 | 1 | null>(null)
    const { dragEnd } = scope
    const handleRadiusM = hitMeters * 3

    const hoveredEntity = hovered && hovered.entity !== road && !memberIds.has(hovered.entity) ? hovered.entity : null
    const layers = useMemo(() => {
        const out: Layer[] = []
        const selectedPaths = scope.state.corridor && !scope.span && scope.paths.length
            ? scope.paths
            : geom.data?.length ? roadPaths(geom.data) : []
        if (selectedPaths.length) {
            out.push(new PathLayer({
                id: "road-selected",
                data: selectedPaths,
                getPath: (d: [number, number][]) => d,
                getColor: [80, 200, 255, 230],
                getWidth: 5,
                widthUnits: "pixels",
                capRounded: true,
                jointRounded: true,
            }))
        }
        if (scope.state.corridor && scope.span) {
            // The corridor's other members, under the span highlight.
            out.push(new PathLayer({
                id: "road-corridor",
                data: scope.corridorMembers.flatMap(m => spanPaths(m.points, { lo: 0, hi: m.chain_mi })),
                getPath: (d: [number, number][]) => d,
                getColor: [80, 200, 255, 160],
                getWidth: 4,
                widthUnits: "pixels",
            }))
        }
        if (scope.span && scope.paths.length) out.push(...highlightLayers("road-scope", scope.paths, [9, 4]))
        if (hoveredEntity !== null) {
            // White on a dark casing, distinct from the (blue) hovered muni / county outline.
            out.push(...highlightLayers("road-hover", roadPaths(hitPoints.filter(p => p.entity === hoveredEntity)), [7, 3]))
        }
        if (scope.anchorPoint && !scope.span) {
            out.push(new ScatterplotLayer<[number, number]>({
                id: "road-anchor",
                data: [scope.anchorPoint],
                getPosition: d => d,
                getFillColor: [255, 170, 0, 240],
                getLineColor: [0, 0, 0, 200],
                stroked: true,
                lineWidthMinPixels: 1.5,
                radiusUnits: "pixels",
                getRadius: 5,
            }))
        }
        if (scope.handles.length) {
            out.push(new ScatterplotLayer<Handle>({
                id: "road-span-handles",
                data: scope.handles,
                getPosition: d => d.lngLat,
                getFillColor: [255, 255, 255, 250],
                getLineColor: [0, 0, 0, 220],
                stroked: true,
                lineWidthMinPixels: 2,
                radiusUnits: "pixels",
                getRadius: 7,
                pickable: true,
                onHover: (i: PickingInfo<Handle>) => { setHandleHover(!!i.object); return false },
                onDragStart: (i: PickingInfo<Handle>) => {
                    if (!i.object) return false
                    dragRef.current = i.object.end
                    return true
                },
                onDrag: (i: PickingInfo<Handle>) => {
                    if (dragRef.current === null) return false
                    dragEnd(dragRef.current, (i.coordinate as [number, number] | undefined) ?? null, handleRadiusM, false)
                    return true
                },
                onDragEnd: (i: PickingInfo<Handle>) => {
                    if (dragRef.current === null) return false
                    dragEnd(dragRef.current, (i.coordinate as [number, number] | undefined) ?? null, handleRadiusM, true)
                    dragRef.current = null
                    setHandleHover(false)
                    return true
                },
                onClick: () => true,
            }))
        }
        return out
    }, [geom.data, hoveredEntity, hitPoints, scope.state.corridor, scope.span, scope.paths, scope.corridorMembers, scope.anchorPoint, scope.handles, dragEnd, handleRadiusM])

    const slug = info.data?.slug ?? null
    const pageHref = slug
        ? `/road/${slug}${(() => {
            const q = new URLSearchParams()
            if (scope.span) q.set("span", encodeSpan(scope.span))
            if (scope.state.corridor) q.set("cor", "")
            if (scope.v5 && !scope.inclusive) q.set("xs", "0")
            const s = q.toString().replace(/cor=(&|$)/, "cor$1")
            return s ? `?${s}` : ""
        })()}`
        : null

    return {
        /** Whether `?road=` names a road (it may still be loading, or not exist). */
        selected: ref !== null,
        road, setRoad, active, hovered, onHover, onClick, onWheel, layers,
        info: info.data ?? null,
        notFound: info.isSuccess && !info.data,
        summary: summary.data ?? null,
        scope,
        pageHref,
        /** Pause map panning: a span end handle is under the cursor (or being dragged). */
        freezePan: handleHover || scope.dragging,
        loading: info.isFetching || geom.isFetching || summary.isFetching || scope.crashesLoading,
    }
}
