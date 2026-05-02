/** Reusable interactive crash map.
 *
 * Base: MapLibre GL via react-map-gl/maplibre (raster tiles).
 * Overlay: Deck.gl layers (Scatterplot / Heatmap / Hexbin) with controlled viewState.
 * Nav: right-click / ctrl-drag rotates; two-finger touch drag pitches (mobile).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Map as MapGl, type MapRef } from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import DeckGL from "@deck.gl/react/typed"
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers/typed"
import { HeatmapLayer } from "@deck.gl/aggregation-layers/typed"
import type { PickingInfo } from "@deck.gl/core/typed"
import type { FeatureCollection } from "geojson"
import { useTouchPitch } from "./hooks/useTouchPitch"
import { binIntoHexes, coarsenHexes, hexesToSegments, buildStackedHexLayer, Segment, StackedHex, H3_RADIUS_METERS } from "./StackedHexLayer"
import { getResolution } from "h3-js"

export type MapMode = "scatter" | "heatmap" | "hexbin"

export type Crash = {
    dt: Date | number
    severity: "i" | "f" | "p"
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
    /** State route number (`route` column in the export). Empty when not on
     *  a numbered route. */
    route?: string
    /** Human-readable road label ("CALDERON AVENUE", "ROUTE 9"). Source
     *  for the `topRoute` per-hex mode. */
    road?: string
    /** Cross-street name at the crash location, when known. */
    cross_street?: string
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
    /** Secondary outline (e.g. muni boundary drawn on top of the county
     *  outline). Rendered above `outline` with a brighter, thicker stroke. */
    muniOutline?: FeatureCollection
    initialBounds?: [number, number, number, number]
    initialCenter?: { longitude: number; latitude: number; zoom: number }
    /** Per-scope initial-view override (replaces `initialBounds`-based auto-fit).
     *  Caller supplies hand-tuned `mobile` and `desktop` view states; this
     *  component lerps between them based on the container width. */
    initialView?: { mobile: ViewState; desktop: ViewState } | null
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
    /** Fired for any click on the map canvas (used for drawer close-on-click). */
    onMapClick?: () => void
    /** Render the internal PitchSlider / HexControls corner widgets.
     *  Caller can disable (when it supplies its own consolidated panel). */
    showInternalControls?: boolean
    mode?: MapMode
    theme?: "light" | "dark"
    height?: number | string
    /** Number of years in the selected range, for per-year rate display in
     *  hex tooltips. When ≥ 2, tooltips show "N crashes (≈N/yr)". */
    yearSpan?: number
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
    p: [220, 200, 90],
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
export function pickHexResolutionForPixels(pixelTarget: number, zoom: number, lat: number): number {
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

/** SRIs in NJDOT data are zero-padded route numbers (e.g. "00000525__") —
 *  show as a friendlier "Route N" label. Once the EC2 pipeline rerun lands
 *  the human-readable `road` field, this fallback rarely fires. Friendly
 *  per-county nicknames (JFK Blvd for 501 in Hudson, etc.) require a
 *  lookup table we don't have yet. */
const SRI_PREFIX_NAMES: Record<string, string> = {
    "1": "US 1", "9": "US 9", "22": "US 22", "30": "US 30", "46": "US 46",
    "70": "US 70", "130": "US 130", "202": "US 202", "206": "US 206",
    "78": "I-78", "80": "I-80", "95": "I-95", "195": "I-195",
    "278": "I-278", "280": "I-280", "287": "I-287", "295": "I-295",
}
function fmtSri(sri: string): string {
    const m = sri.match(/^0+(\d+)/)
    if (!m) return `SRI ${sri}`
    const num = m[1]
    return SRI_PREFIX_NAMES[num] ?? `Route ${num}`
}

/** Perf instrumentation enabled when URL has `?perf=1`. Cheap (sync url
 *  read; no logging on the hot path otherwise). Used by the e2e
 *  `map-perf.spec.ts` to measure binning + layer-rebuild times. */
function perfEnabled(): boolean {
    if (typeof window === "undefined") return false
    return new URLSearchParams(window.location.search).get("perf") === "1"
}

/** Module-scoped per-`crashes`-identity bin cache. Survives CrashMap
 *  Suspense remounts (the component can mount → unmount → remount during
 *  initial data load + URL settling, and a useRef-based cache would be
 *  thrown away each cycle). WeakMap → entries GC when the source array is
 *  no longer referenced. */
const moduleBinCache: WeakMap<object, Map<number, StackedHex[]>> = new WeakMap()
function getBinCache(src: object): Map<number, StackedHex[]> {
    let m = moduleBinCache.get(src)
    if (!m) {
        m = new Map()
        moduleBinCache.set(src, m)
    }
    return m
}

function fmtDate(d: Date | number): string {
    // Point shards encode `dt` as epoch *minutes* (int32) per the export
    // pipeline, not milliseconds. Multiply by 60_000 before `new Date()`.
    const date = d instanceof Date ? d : new Date(Number(d) * 60_000)
    return date.toISOString().slice(0, 10)
}


/** Web-mercator fit: zoom where `[w,s,e,n]` fits inside (containerW×containerH)
 *  pixels at the bounds' center latitude. For pitched views (pitch > 0),
 *  applies two corrections to keep the full bbox visible:
 *  - Zoom out proportionally to pitch (full bbox doesn't clip on the near
 *    side, which compresses vertically due to perspective).
 *  - Shift latitude toward the camera (south, assuming bearing=0) so the
 *    asymmetric visible ground area centers on the bbox. */
export function fitBoundsToView(
    bounds: [number, number, number, number],
    containerW: number,
    containerH: number,
    pitch = 0,
    padPx = 40,
): ViewState {
    const [w, s, e, n] = bounds
    const lon = (w + e) / 2
    const bboxCenterLat = (s + n) / 2
    const cw = Math.max(50, containerW - padPx * 2)
    const ch = Math.max(50, containerH - padPx * 2)
    const COS = Math.cos(bboxCenterLat * Math.PI / 180)
    const metersPerDegLon = 111_320 * COS
    const metersPerDegLat = 110_574
    const lateralM = Math.max(1, (e - w) * metersPerDegLon)
    const verticalM = Math.max(1, (n - s) * metersPerDegLat)
    // Pitch compresses the "near" half of the visible ground; treat the
    // effective container as smaller vertically. Exponent `1.5` on cos(pitch)
    // empirically matches user-tuned views for Bergen / Hudson / Monmouth
    // better than cos(pitch)^2 (too loose) or cos(pitch) (too tight).
    const pitchRad = pitch * Math.PI / 180
    const chEff = ch * Math.pow(Math.cos(pitchRad), 1.5)
    const mppNeeded = Math.max(lateralM / cw, verticalM / chEff)
    const zoom = Math.log2(156543.03 * COS / mppNeeded)
    // Shift the center slightly toward the camera (south at bearing=0) so the
    // bbox's south edge isn't buried in the pitched near-field. Kept small
    // (~10% of bbox height) — users prefer near-centered over visually-centered.
    const latShiftDeg = -(n - s) * 0.1 * Math.sin(pitchRad)
    return {
        latitude: bboxCenterLat + latShiftDeg,
        longitude: lon,
        zoom: Math.max(7, Math.min(18, zoom)),
        pitch,
        bearing: 0,
    }
}

/** Width thresholds for {mobile, desktop} `initialView` interpolation.
 *  Outside the range we clamp; inside we linearly lerp all fields. */
const LERP_MIN_W = 400
const LERP_MAX_W = 900

function lerpView(o: { mobile: ViewState; desktop: ViewState }, containerW: number): ViewState {
    const t = Math.max(0, Math.min(1, (containerW - LERP_MIN_W) / (LERP_MAX_W - LERP_MIN_W)))
    const { mobile: m, desktop: d } = o
    return {
        latitude: m.latitude + t * (d.latitude - m.latitude),
        longitude: m.longitude + t * (d.longitude - m.longitude),
        zoom: m.zoom + t * (d.zoom - m.zoom),
        pitch: m.pitch + t * (d.pitch - m.pitch),
        bearing: m.bearing + t * (d.bearing - m.bearing),
    }
}

function defaultView(
    initialBounds: Props["initialBounds"],
    initialCenter: Props["initialCenter"],
    initialView: Props["initialView"],
    mode: MapMode,
): ViewState {
    const pitch = mode === "hexbin" ? 45 : 0
    if (initialView) {
        // Approximate container width from window. Fit effect will re-lerp
        // with measured width once the container mounts.
        const w = typeof window !== "undefined" ? Math.max(300, Math.min(1200, window.innerWidth * 0.6)) : 800
        return lerpView(initialView, w)
    }
    if (initialBounds) {
        // Guess a reasonable fit using window dims — `fitBoundsToView` will
        // re-fit more precisely once the container is measured. Starting
        // near the target zoom avoids a visible zoom-out-then-snap on load,
        // and avoids a hard-coded `zoom:11` that can stick when deck.gl's
        // controller echoes the initial viewState back synchronously.
        const w = typeof window !== "undefined" ? Math.max(300, Math.min(1200, window.innerWidth * 0.6)) : 800
        const h = typeof window !== "undefined" ? Math.max(300, Math.min(800, window.innerHeight * 0.6)) : 500
        return fitBoundsToView(initialBounds, w, h, pitch)
    }
    return { ...(initialCenter ?? { longitude: -74.08, latitude: 40.73, zoom: 11 }), pitch, bearing: 0 }
}

export function CrashMap({
    crashes,
    prebinnedHexes,
    outline,
    muniOutline,
    initialBounds,
    initialCenter,
    initialView,
    viewState: controlledView,
    onViewStateChange: onControlledChange,
    hexPxTarget: controlledHexPxTarget,
    onHexPxTargetChange,
    elevationPerCount: controlledElevation,
    onElevationPerCountChange,
    onOutlineClick,
    onMapClick,
    showInternalControls = true,
    mode = "scatter",
    theme = "dark",
    height = "100%",
    yearSpan,
}: Props) {
    const effectiveCrashes = crashes ?? []
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const [localViewState, setLocalViewState] = useState<ViewState>(() => defaultView(initialBounds, initialCenter, initialView, mode))
    const viewState = controlledView ?? localViewState
    // Ref mirrors current viewState so `setViewState` can compute `next`
    // without putting a parent-notifying side effect inside the setState
    // updater (which React warns about: "Cannot update a component while
    // rendering a different component").
    const viewStateRef = React.useRef<ViewState>(viewState)
    viewStateRef.current = viewState
    // Auto-fit bounds when uncontrolled: re-run whenever `initialBounds` change
    // AND the container has a measurable size. Caller-owned `controlledView`
    // skips this (CrashMapPage does its own `fitBoundsToView`).
    // `initialView` (per-scope override) takes precedence over `initialBounds`
    // auto-fit; lerps by container width.
    const fitKeyRef = React.useRef<string>("")
    useEffect(() => {
        if (controlledView !== undefined) return
        if (!initialView && !initialBounds) return
        const el = containerRef.current
        if (!el) return
        const tryFit = () => {
            const { clientWidth: cw, clientHeight: ch } = el
            if (!cw || !ch) return false
            const boundsKey = initialBounds ? initialBounds.join(",") : ""
            const ivKey = initialView ? `${initialView.mobile.zoom},${initialView.desktop.zoom}` : ""
            const key = `${boundsKey}-${ivKey}-${cw}x${ch}-${mode}`
            if (key === fitKeyRef.current) return true
            fitKeyRef.current = key
            setLocalViewState(
                initialView
                    ? lerpView(initialView, cw)
                    : fitBoundsToView(initialBounds!, cw, ch, mode === "hexbin" ? 45 : 0)
            )
            return true
        }
        if (tryFit()) return
        // Container not yet sized — observe until it is.
        const ro = new ResizeObserver(() => { tryFit() })
        ro.observe(el)
        return () => ro.disconnect()
    }, [initialBounds, initialView, controlledView, mode])
    // User-driven view changes go through `setViewState` (pan/drag via
    // `onViewStateChange`, pitch via slider/touch). Fit-effect updates
    // call `setLocalViewState` directly to avoid notifying the parent
    // for auto-fit.
    const setViewState: React.Dispatch<React.SetStateAction<ViewState>> = useCallback((updater) => {
        if (controlledView !== undefined) {
            const next = typeof updater === "function" ? (updater as (v: ViewState) => ViewState)(controlledView) : updater
            onControlledChange?.(next)
            return
        }
        const prev = viewStateRef.current
        const next = typeof updater === "function" ? (updater as (v: ViewState) => ViewState)(prev) : updater
        setLocalViewState(next)
        // Notify parent only on actual change (persist user interactions to
        // URL). No-op updates from mode-switch auto-tilt etc. must not leak
        // to `?llz=`.
        const changed = next.longitude !== prev.longitude
            || next.latitude !== prev.latitude
            || next.zoom !== prev.zoom
            || next.pitch !== prev.pitch
            || next.bearing !== prev.bearing
        if (changed && onControlledChange) onControlledChange(next)
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

    // Per-resolution bin cache: re-binning ~250k rows takes ~330ms on a fast
    // M1, blocking the main thread. Cache by H3 resolution so once we've
    // binned at r6 / r7 / r8, navigating zoom levels back through them is
    // O(1). Cache lives at module scope (keyed by the crashes array
    // reference via WeakMap) so it survives Suspense / data-loading
    // remounts of CrashMap itself.
    const binCache = getBinCache(effectiveCrashes)

    // Hexes (memoized separately from `layers` so it doesn't re-run when
    // unrelated layer deps — outline geojson, mode-tilt, etc. — change).
    const hexes = useMemo<StackedHex[] | null>(() => {
        if (mode !== "hexbin") return null
        if (prebinnedHexes) {
            const t0 = perfEnabled() ? performance.now() : 0
            const out = coarsenHexes(prebinnedHexes, effectiveHexRes)
            if (perfEnabled()) {
                const w = window as any
                w.__crashMapDebug = {
                    ...(w.__crashMapDebug ?? {}),
                    hexCount: out.length,
                    resolution: effectiveHexRes,
                    crashCount: prebinnedHexes.length,
                    lastBinMs: performance.now() - t0,
                }
                console.log(`[perf] coarsenHexes r${effectiveHexRes}: ${(performance.now() - t0).toFixed(1)}ms `
                    + `(${prebinnedHexes.length} prebins → ${out.length} hexes)`)
            }
            return out
        }
        const cache = binCache
        let bins = cache.get(effectiveHexRes)
        if (!bins) {
            const t0 = perfEnabled() ? performance.now() : 0
            bins = binIntoHexes(effectiveCrashes, effectiveHexRes)
            cache.set(effectiveHexRes, bins)
            if (perfEnabled()) {
                const ms = performance.now() - t0
                const w = window as any
                w.__crashMapDebug = {
                    ...(w.__crashMapDebug ?? {}),
                    hexCount: bins.length,
                    resolution: effectiveHexRes,
                    crashCount: effectiveCrashes.length,
                    lastBinMs: ms,
                }
                console.log(`[perf] binIntoHexes r${effectiveHexRes}: ${ms.toFixed(1)}ms `
                    + `(${effectiveCrashes.length} rows → ${bins.length} hexes)`)
            }
        } else if (perfEnabled()) {
            const w = window as any
            w.__crashMapDebug = {
                ...(w.__crashMapDebug ?? {}),
                hexCount: bins.length,
                resolution: effectiveHexRes,
                lastBinMs: 0,  // cached
            }
        }
        return bins
    }, [mode, prebinnedHexes, effectiveCrashes, effectiveHexRes])

    // Idle prewarm: after data is loaded, bin all common resolutions in
    // chained idle callbacks. Subsequent zoom-driven res transitions hit the
    // cache and are O(1). Skipped for prebin mode (we already have one
    // canonical resolution; coarsenHexes is fast).
    useEffect(() => {
        if (mode !== "hexbin" || prebinnedHexes || effectiveCrashes.length === 0) return
        if (perfEnabled()) console.log(`[perf] prewarm scheduled (${effectiveCrashes.length} rows)`)
        const cache = binCache
        const COMMON_RES = [6, 7, 8, 9, 10]
        let i = 0
        let cancelled = false
        const ric: (cb: () => void) => any =
            (window as any).requestIdleCallback ?? ((cb) => setTimeout(cb, 50))
        const cic: (h: any) => void =
            (window as any).cancelIdleCallback ?? ((h) => clearTimeout(h))
        let handle: any
        const tick = () => {
            if (cancelled) return
            // Skip resolutions already cached.
            while (i < COMMON_RES.length && cache.has(COMMON_RES[i])) i++
            if (i >= COMMON_RES.length) {
                if (perfEnabled()) console.log(`[perf] prewarm done`)
                return
            }
            const res = COMMON_RES[i++]
            const t0 = perfEnabled() ? performance.now() : 0
            cache.set(res, binIntoHexes(effectiveCrashes, res))
            if (perfEnabled()) {
                console.log(`[perf] prewarm r${res}: ${(performance.now() - t0).toFixed(1)}ms`)
            }
            handle = ric(tick)
        }
        handle = ric(tick)
        return () => { cancelled = true; if (handle) cic(handle) }
    }, [mode, prebinnedHexes, effectiveCrashes])

    const outlineLayers = useMemo(() => {
        const layers: any[] = []
        const lineRgb: [number, number, number] = theme === "dark" ? [109, 179, 242] : [0, 102, 204]
        // County (or parent) outline: dimmed when a muni overlay is present
        // so it reads as context without competing visually.
        if (outline) {
            const alpha = muniOutline ? 100 : 204
            layers.push(new GeoJsonLayer({
                id: "outline",
                data: outline,
                getFillColor: onOutlineClick ? [...lineRgb, 12] as any : [0, 0, 0, 0] as any,
                getLineColor: [...lineRgb, alpha] as any,
                lineWidthMinPixels: muniOutline ? 0.8 : 1.5,
                pickable: !!onOutlineClick,
                onClick: onOutlineClick ? (info: any) => {
                    if (info.object) { onOutlineClick(info.object); return true }
                    return false
                } : undefined,
                updateTriggers: {
                    getFillColor: [theme, !!onOutlineClick],
                    getLineColor: [theme, !!muniOutline],
                    lineWidthMinPixels: [!!muniOutline],
                },
            }))
        }
        // Muni outline: brighter, slightly thicker, drawn on top.
        if (muniOutline) {
            layers.push(new GeoJsonLayer({
                id: "muni-outline",
                data: muniOutline,
                getFillColor: [0, 0, 0, 0] as any,
                getLineColor: [...lineRgb, 230] as any,
                lineWidthMinPixels: 1.8,
                pickable: false,
                updateTriggers: { getLineColor: [theme] },
            }))
        }
        return layers
    }, [outline, muniOutline, theme, onOutlineClick])

    const layers = useMemo(() => {
        const t0 = perfEnabled() ? performance.now() : 0
        const base: any[] = [...outlineLayers]
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
        // Detail mode bins fresh at `effectiveHexRes`. Statewide loads a
        // single fixed-res prebin (e.g. r8) — when the zoom-driven target
        // is coarser than the prebin, coarsen client-side via H3 parent
        // (exact, lossless). Finer than the prebin: nothing we can do
        // without raw rows; cells just render larger than ideal.
        if (!hexes || hexes.length === 0) return base
        const hexesArr = hexes
        // Auto-scale bar heights based on the visible max count: when the
        // user filters to fatal-only (max ~5) we'd otherwise get pancake
        // bars vs the baseline fatal+injury view (max ~100). Keep the
        // tallest bar near a target height of `elevationPerCount × 100`,
        // clamped so we don't inflate single-crash hexes wildly. Sqrt-
        // softened so the slider still has perceptible effect.
        const maxCount = hexesArr.reduce((m, h) => Math.max(m, h.total), 1)
        const HEIGHT_TARGET = 100  // calibrated for typical fatal+injury max
        const autoScale = Math.min(8, Math.max(0.4, Math.sqrt(HEIGHT_TARGET / maxCount)))
        const effectiveElevation = elevationPerCount * autoScale
        const segments = hexesToSegments(hexesArr, effectiveElevation)
        // Render columns sized to the data's actual H3 res, not the picker's
        // desired one. Prebinned data (`prebinnedHexes`) is fetched at a fixed
        // resolution (r6 fallback or r7/r8/r9 picked by `pickFetchPlanV2`);
        // when zoom drives `effectiveHexRes` finer than what we have, the
        // column radius would shrink below the cell's hex-tant and reveal the
        // underlying lattice as visible gaps between bars.
        const renderRes = Math.min(effectiveHexRes, getResolution(hexesArr[0].h3))
        const result = [...base,
            buildStackedHexLayer({
                id: "crashes-hex-stacked",
                segments,
                resolution: renderRes,
                pickable: true,
                onHover: (info) => { setHoverInfo(info); return false },
            }),
        ]
        if (perfEnabled()) {
            const ms = performance.now() - t0
            console.log(`[perf] layers: ${ms.toFixed(1)}ms (mode=${mode}, segments=${segments.length})`)
        }
        return result
    }, [hexes, effectiveCrashes, mode, effectiveHexRes, elevationPerCount, outlineLayers])

    // Only bubble user-driven changes. DeckGL also echoes back programmatic
    // viewState updates (from the fit effect, mode-switch tilt, etc.) via
    // onViewStateChange with no interactionState — ignoring those avoids
    // leaking the auto-fit into `?llz=` and stops a re-entrancy loop where
    // the callback clobbers our own setState.
    const onViewStateChange = useCallback(({ viewState: vs, interactionState }: any) => {
        if (isPitchingRef.current) return
        const interacting = interactionState && (
            interactionState.isDragging ||
            interactionState.isPanning ||
            interactionState.isZooming ||
            interactionState.isRotating ||
            interactionState.inTransition
        )
        if (!interacting) return
        const { longitude, latitude, zoom, pitch, bearing } = vs
        setViewState({ longitude, latitude, zoom, pitch, bearing })
    }, [isPitchingRef])

    const style = useMemo(() => rasterStyle(theme), [theme])

    return (
        <div ref={containerRef} style={{ position: "relative", height, width: "100%" }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={onViewStateChange}
                controller={{ touchRotate: true, dragRotate: true, maxPitch: MAX_PITCH, maxZoom: 20, minZoom: 0 } as any}
                layers={layers}
                onClick={onMapClick ? () => { onMapClick() } : undefined}
                style={{ position: "absolute", inset: "0" }}
            >
                <MapGl
                    ref={mapRef}
                    mapStyle={style}
                    maxPitch={MAX_PITCH}
                    minZoom={0}
                    maxZoom={20}
                    attributionControl={false}
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
            {hoverInfo?.object && mode !== "heatmap" && <CrashTooltip info={hoverInfo} yearSpan={yearSpan} />}
            <AttributionPopover theme={theme} />
        </div>
    )
}

/** Compact "ⓘ" badge in the bottom-left that reveals the tile attribution on
 *  hover. Replaces MapLibre's default AttributionControl (disabled) with
 *  something less screenshot-noisy while still honoring Stadia's attribution
 *  terms (https://stadiamaps.com/docs/attribution). */
function AttributionPopover({ theme }: { theme: "light" | "dark" }) {
    const [open, setOpen] = useState(false)
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const border = `1px solid ${theme === "dark" ? "#444" : "#ccc"}`
    const linkStyle: React.CSSProperties = { color: fg, textDecoration: "underline" }
    return (
        <div
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            style={{ position: "absolute", bottom: 8, left: 8, zIndex: 1000 }}
        >
            <button
                type="button"
                aria-label="Map attribution"
                onClick={() => setOpen(o => !o)}
                style={{
                    background: bg, color: fg, border, borderRadius: 4,
                    width: 20, height: 20, padding: 0, fontSize: "0.75em",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                }}
            >ⓘ</button>
            {open && (
                <div style={{
                    position: "absolute", bottom: "100%", left: 0,
                    background: bg, color: fg, border, borderRadius: 4,
                    padding: "4px 8px", fontSize: "0.72em", whiteSpace: "nowrap",
                    pointerEvents: "auto",
                }}>
                    © <a href="https://stadiamaps.com/" style={linkStyle}>Stadia Maps</a>
                    {" · "}
                    <a href="https://openmaptiles.org/" style={linkStyle}>OpenMapTiles</a>
                    {" · "}
                    <a href="https://www.openstreetmap.org/copyright" style={linkStyle}>OpenStreetMap</a>
                </div>
            )}
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

function fmtRate(n: number, yearSpan: number | undefined): string {
    if (!yearSpan || yearSpan < 2) return ""
    const rate = n / yearSpan
    const formatted = rate >= 10 ? Math.round(rate).toString() : rate.toFixed(1)
    return ` · ${formatted}/yr`
}

function CrashTooltip({ info, yearSpan }: { info: PickingInfo; yearSpan?: number }) {
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
                {h.topRoute && (
                    <div style={{ fontSize: "0.85em", opacity: 0.85, marginBottom: 2 }}>
                        near <b>{h.topRoute}</b>
                    </div>
                )}
                <div><b>{h.total}</b> crashes{fmtRate(h.total, yearSpan)}</div>
                {h.fatal > 0 && (
                    <div style={{ color: "rgb(210,28,28)" }}>
                        <b>{h.fatal}</b> fatal{fmtRate(h.fatal, yearSpan)}
                    </div>
                )}
                {injury > 0 && (
                    <div style={{ color: "rgb(245,158,11)" }}>
                        <b>{injury}</b> injury{h.pedInj > 0 ? ` (incl. ${h.pedInj} ped/cyclist)` : ""}{fmtRate(injury, yearSpan)}
                    </div>
                )}
                {h.pdo > 0 && (
                    <div style={{ color: "rgb(220,200,90)" }}>
                        <b>{h.pdo}</b> other{fmtRate(h.pdo, yearSpan)}
                    </div>
                )}
            </div>
        )
    }
    return (
        <div style={tooltipStyle(info)}>
            {isHex ? (
                <>
                    <div><b>{obj.points.length}</b> crashes{fmtRate(obj.points.length, yearSpan)}</div>
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
                    <div><b>{obj.severity === "f" ? "Fatal" : obj.severity === "p" ? "Other" : "Injury"}</b> · {fmtDate(obj.dt)}</div>
                    <div>{
                        [
                            obj.tk > 0 ? `${obj.tk} killed` : null,
                            obj.ti > 0 ? `${obj.ti} injured` : null,
                            obj.tv > 0 ? `${obj.tv} vehicle${obj.tv === 1 ? "" : "s"}` : null,
                        ].filter(Boolean).join(" · ") || "No reported casualties"
                    }</div>
                    {(obj.pk > 0 || obj.pi > 0) && (
                        <div>Pedestrians: {obj.pk} killed, {obj.pi} injured</div>
                    )}
                    {obj.road && (
                        <div>
                            {obj.road}
                            {obj.cross_street && <> at <b>{obj.cross_street}</b></>}
                            {obj.mp != null && Number.isFinite(obj.mp) && <> · MP {obj.mp.toFixed(2)}</>}
                        </div>
                    )}
                    {!obj.road && obj.sri && obj.mp != null && Number.isFinite(obj.mp) && (
                        <div style={{ opacity: 0.7, fontSize: "0.85em" }}>{fmtSri(obj.sri)} · MP {obj.mp.toFixed(2)}</div>
                    )}
                </>
            )}
        </div>
    )
}
