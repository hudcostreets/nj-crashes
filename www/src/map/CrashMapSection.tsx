/** Crash-map panel — the single map implementation behind both the
 *  Home.tsx `#map` embed and the standalone full-screen `/map` route.
 *
 *  Scope (cc, mc) comes from the caller. With `fullScreen` set, it fills
 *  the viewport (the `/map` route); otherwise it's an embedded,
 *  drag-resizable panel. Either way: cells-api backend, year-range
 *  selects, severity Legend, hexbin controls, debug drawer.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useUrlState, viewStateParam, cleanUrl, optFloatParam, boolParam, enumParam } from "use-prms"
import { usePageFilters, YEAR_RANGE_DEFAULT } from "@/src/PageFiltersContext"
import type { CrashFilter } from "@/src/map/useCrashData"
import { useCellsApi, CELLS_BUDGET } from "@/src/map/useCellsApi"
import type { CellsApiFilter } from "@/src/map/useCellsApi"
import { coarsenHexes } from "@/src/map/StackedHexLayer"
import { getResolution } from "h3-js"
import { MAP_BASE_URL } from "@/src/map/config"
import type { MapMode, ViewState } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import { useTheme } from "@/src/contexts/ThemeContext"
import type { FeatureCollection } from "geojson"
import { FiMaximize2, FiMinimize2 } from "react-icons/fi"
import useSessionStorageState from "use-session-storage-state"
import { useToolboxOpen } from "@/src/map/useToolboxOpen"
import { bboxFromViewport, loadManifestV2 } from "@/src/map/v2"
import type { MapManifestV2 } from "@/src/map/v2"
import { fitBoundsToView, lerpView, metersPerPixel, pickHexResolutionForPixels } from "@/src/map/CrashMap"
import { H3_RADIUS_METERS } from "@/src/map/StackedHexLayer"

import { circleRadiusPx, hexPxTargetFor, pickRes, BINS_BUDGET } from "@/src/map/picker"
import { pickS2LevelForPixels } from "@/src/map/s2"
import { DebugOverlay } from "@/src/map/DebugOverlay"
import { YearSelect } from "@/src/lib/year-select"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

/** Approximate visible-viewport pixel dims used for the shard-selection
 *  bbox + hex-resolution picking. Full-screen fills the window; the embed
 *  is width-capped at 1280 and a fixed 480px tall (its real height varies
 *  with the user's drag-resize, but 480 is a fine picker midpoint). */
function viewportDims(fullScreen: boolean): [number, number] {
    if (typeof window === "undefined") return [1280, 480]
    return fullScreen
        ? [window.innerWidth, window.innerHeight]
        : [Math.min(window.innerWidth, 1280), 480]
}

/** Extract a polygon's outer ring (`[lon, lat][]`) from the first
 *  Polygon/MultiPolygon feature in a FeatureCollection. For
 *  MultiPolygon, takes the largest sub-polygon by vertex count (good
 *  proxy for a county's mainland vs. small islands). Returns undefined
 *  when nothing usable is found.
 *
 *  Used to send the active scope's admin boundary to the cells-api
 *  worker as a `polygon=` clip — drops cells whose center isn't in the
 *  county/muni so the embedded map doesn't show neighboring areas
 *  spilling out around the admin boundary. */
function extractOuterRing(fc: FeatureCollection): [number, number][] | undefined {
    const feat = fc.features[0]
    if (!feat) return undefined
    const g = feat.geometry as any
    if (g?.type === "Polygon" && Array.isArray(g.coordinates?.[0])) {
        return g.coordinates[0] as [number, number][]
    }
    if (g?.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
        let largest: [number, number][] | undefined
        for (const poly of g.coordinates) {
            const ring = poly?.[0] as [number, number][] | undefined
            if (ring && (!largest || ring.length > largest.length)) largest = ring
        }
        return largest
    }
    return undefined
}

/** Per-county initial view overrides (mobile + desktop pairs, lerped by width).
 *  Keys are numeric county codes (cc). Captured from user-tuned `?llz=` URLs
 *  and used instead of `initialBounds` auto-fit for these scopes. Add entries
 *  by loading the map, dragging to the desired framing at mobile and desktop
 *  viewport widths, and copying the `?llz=` values into this table. */
const LLZ_OVERRIDES: Record<number, { mobile: ViewState; desktop: ViewState }> = {
    2: {  // Bergen (single value — good at both widths)
        mobile:  { latitude: 40.9267, longitude: -74.0606, zoom: 9.66, pitch: 45, bearing: 0 },
        desktop: { latitude: 40.9267, longitude: -74.0606, zoom: 9.66, pitch: 45, bearing: 0 },
    },
    9: {  // Hudson
        mobile:  { latitude: 40.7135, longitude: -74.0956, zoom: 10.63, pitch: 45, bearing: 0 },
        desktop: { latitude: 40.7119, longitude: -74.0936, zoom: 10.84, pitch: 45, bearing: 0 },
    },
    13: {  // Monmouth
        mobile:  { latitude: 40.1719, longitude: -74.3069, zoom: 8.65, pitch: 45, bearing: 0 },
        desktop: { latitude: 40.2188, longitude: -74.3049, zoom: 9.61, pitch: 45, bearing: 0 },
    },
}

/** Statewide initial view for the full-screen `/map` route. The
 *  `fitBoundsToView` auto-fit leaves NJ at ~45% of a tall full-screen
 *  viewport (the pitch model + padding zoom out generously) — these
 *  hand-tuned values frame NJ much tighter. Full-screen only: the short
 *  `#map` embed keeps the bbox auto-fit (height-appropriate). Re-tune by
 *  dragging to taste at mobile + desktop widths and copying `?llz=`. */
const STATEWIDE_VIEW: { mobile: ViewState; desktop: ViewState } = {
    mobile:  { latitude: 39.90, longitude: -74.60, zoom: 7.85, pitch: 45, bearing: 0 },
    desktop: { latitude: 39.83, longitude: -74.55, zoom: 8.95, pitch: 45, bearing: 0 },
}

/** `llz` URL param: "lat lng zoom pitch bearing" (signed-delim — `+` or
 *  `-` separates instead of `_`, so URLs read like `40.71-74.09+10.84+45+0`).
 *  Pitch/bearing optional; missing pitch falls back to 45 (the deck.gl 3D
 *  tilt default we use for crash-map embeds). Overrides the auto-fit. */
const llzParam = viewStateParam({
    default: null,
    pitchFallback: 45,
})

/** Legacy `v` URL param (parquet-backed CrashMapPage, pre-unification):
 *  `lat_lon_zoom_pitch_bearing` — underscore-separated. Migrated to the new
 *  `llz` param via `cleanUrl({ deprecated: { v: parseLegacyV } })` on mount;
 *  see the `useEffect` below. */
function parseLegacyV(raw: string): { llz?: { latitude: number; longitude: number; zoom: number; pitch: number; bearing: number } } {
    const parts = raw.split("_").map(Number)
    if (parts.length < 3 || parts.some(Number.isNaN)) return {}
    const [latitude, longitude, zoom, pitch = 45, bearing = 0] = parts
    return { llz: { latitude, longitude, zoom, pitch, bearing } }
}

// Year range is read from the page-level `<PageFiltersProvider>` (URL
// param `yr`). Both the Home embed and the fullscreen `/map` route wrap
// this component in a provider, so `usePageFilters()` is never null in
// practice.

export type Props = {
    /** County code (1-21) or null for statewide. */
    cc: number | null
    /** Municipality code (within cc) or null. */
    mc: number | null
    /** Initial / default embed height in px. User can drag-resize the
     *  bottom edge; the choice persists in SS, with a reset button to
     *  restore this default. Defaults to 600px. Ignored when `fullScreen`. */
    height?: number
    /** Optional `href` for the full-screen icon (bottom-right). Omit to hide.
     *  Ignored when `fullScreen` (the corner icon becomes a minimize button). */
    fullScreenHref?: string
    /** Geographic scope label rendered in the subtitle (e.g.
     *  "Jersey City, Hudson County"). When omitted, the subtitle is hidden. */
    scopeLabel?: string
    /** Render as a full-viewport standalone page (the `/map` route) instead
     *  of an embedded panel: fills 100vw×100vh, no drag-resize, the header
     *  becomes a top-center overlay, and the corner icon is a "back to
     *  charts" minimize button (→ `detailsHref`). */
    fullScreen?: boolean
    /** Charts-page href for the full-screen minimize button. */
    detailsHref?: string
    /** Outline-polygon click handler (geo drill-down). The full-screen
     *  `/map` route uses it to navigate statewide → county. */
    onOutlineClick?: (feature: any) => void
}

export function CrashMapSection({
    cc, mc, height: defaultHeight = 600, fullScreenHref, scopeLabel,
    fullScreen = false, detailsHref, onOutlineClick,
}: Props) {
    const { actualTheme } = useTheme()
    const [mode, setMode] = useState<MapMode>("hexbin")
    // Year range comes from the page-level filter provider — same `yr`
    // URL param that drives the NJSP/NJDOT plots + tables below. Fallback
    // to a static default lets the map still render if someone drops the
    // component in without a provider (should not happen on our routes).
    const filters = usePageFilters()
    const yearRange = filters?.yearRange ?? YEAR_RANGE_DEFAULT
    const setYearRange = filters?.setYearRange ?? (() => {})
    const [severities, setSeverities] = useState<Set<"f" | "i" | "p">>(() => new Set(["f", "i", "p"]))
    // `hpx` (hex-pixel target) and `hs` (bar height scale) are URL-persisted
    // so a shared map link reproduces the exact viz — otherwise slider tweaks
    // silently reset on page reload. Defaults chosen to feel neutral across
    // muni + county scopes.
    // • `hpx` — hex px target. Higher = coarser hexes (fewer, chunkier).
    // • `hs`  — bar height *scale*: the tallest hexbin's rendered height
    //           is `hs × maxDim(regionBbox)` in meters. So `hs=0.3` means
    //           "tallest bar ≈ 30% of the region's largest dimension" —
    //           consistent visual weight regardless of zoom / muni size.
    const [hexPxTargetUrl, setHexPxTargetUrl] = useUrlState("hpx", optFloatParam(), { debounce: 100 })
    const [heightScaleUrl, setHeightScaleUrl] = useUrlState("hs", optFloatParam(), { debounce: 100 })
    // `viz=circle` — prototype circle-column mode. Radius follows a
    // smooth `target_px(z)` curve, capped at each cell's inscribed
    // circle, so res transitions don't visually pop and we get
    // density-scaled dots (small at wide zoom, chunkier deep-zoom).
    const [viz, setViz] = useUrlState("viz", enumParam("circle" as const, ["hex", "circle"] as const))
    // `grid=h3|s2` — which cell grid the picker + fetch layer operate on.
    // H3 stays the default; S2 is the alternate stack (see
    // `specs/s2-pyramid.md`). Client plumbing landed ahead of pyramid + worker
    // support: `?grid=s2` computes S2 levels for display in the widget, but
    // the actual /v1/cells fetch still uses H3 until phases 3-4 land.
    const [grid, setGrid] = useUrlState("grid", enumParam("h3" as const, ["h3", "s2"] as const))
    void setGrid
    // `hexAuto` — when true (default), hexPxTarget grows with zoom so
    // close-up views get chunkier, more-pickable cells; when false, the
    // manual slider value wins. `?ha=false` to opt out of adaptive.
    const [hexAutoUrl, setHexAutoUrl] = useUrlState("ha", boolParam)
    // Bins-per-viewport budget — target hex count that fills the map
    // canvas. Lower = coarser hexes = fewer bins = faster /cells. The
    // spec (`specs/autores-bins-budget.md`) sweeps {3k, 5k, 8k}; the
    // module default lives in `picker.ts` (`BINS_BUDGET`). URL param
    // `?bins=<N>` for A/B eval via `/dev/ab`.
    const [binsUrl, setBinsUrl] = useUrlState("bins", optFloatParam(), { debounce: 100 })
    const binsBudget = binsUrl ?? BINS_BUDGET
    void setBinsUrl
    // `boolParam` default is `false`; we invert to keep the URL absent
    // when the user is on the default (auto=on). `?ha=1` when disabled.
    const hexAuto = !hexAutoUrl
    const setHexAuto = (v: boolean) => setHexAutoUrl(!v)
    const heightScale = heightScaleUrl ?? 0.3
    const setHeightScale = (v: number) => setHeightScaleUrl(v === 0.3 ? null : v)
    const manualHexPx = hexPxTargetUrl ?? 1.7
    const setHexPxTarget = (v: number) => setHexPxTargetUrl(v === 1.7 ? null : v)
    // Drawer defaults open on the full-screen route (room to spare) and
    // closed in the embed (don't occlude the small panel on first paint).
    const [drawerOpen, setDrawerOpen] = useToolboxOpen(fullScreen)
    const [debugOpen, setDebugOpen] = useSessionStorageState<boolean>("hccs.crashmap.debugOpen", { defaultValue: false })
    // Picker-threshold knobs (debug section). SS-persisted so a debugging
    // session survives page reloads. Defaults match `pickFetchPlanV2`.
    const [pointZoomThreshold, setPointZoomThreshold] = useSessionStorageState<number>("hccs.crashmap.pointZoomThreshold", { defaultValue: 11 })
    const [maxPointShards, setMaxPointShards] = useSessionStorageState<number>("hccs.crashmap.maxPointShards", { defaultValue: 10 })
    const [maxHexShards, setMaxHexShards] = useSessionStorageState<number>("hccs.crashmap.maxHexShards", { defaultValue: 100 })
    // User-resizable map height (drag bottom edge of the wrapper; CSS
    // `resize: vertical`). Persisted per session. Reset (↺) restores the
    // caller-provided default.
    const [mapHeight, setMapHeight] = useSessionStorageState<number>("hccs.crashmap.height", { defaultValue: defaultHeight })
    // Debounce URL writes during drag — without it, every per-frame
    // `setLlz` calls `history.replaceState` + dispatches a synthetic
    // `popstate`, which forces every `useUrlState` hook (and the router)
    // to re-evaluate. At ~60fps that's enough sub-50ms work to make the
    // basemap tile-render visibly stutter behind the (GPU-driven) deck.gl
    // polygon layer. State updates still apply immediately via use-prms's
    // `pendingRef`, so the map keeps tracking the cursor.
    const [llz, setLlz] = useUrlState("llz", llzParam, { debounce: 100 })

    // One-shot migration: rewrite legacy `v=lat_lon_zoom_pitch_bearing` URLs
    // (parquet-backed CrashMapPage, pre-unification) into the new `llz=`
    // form, then strip `v=`. No-op when `v=` isn't present (cleanUrl
    // early-returns without touching history). The migrated `llz=` value
    // is picked up by the `useUrlState` hook above on the next popstate
    // cleanUrl dispatches, so the user briefly sees the auto-fit before
    // snapping to the bookmarked view — acceptable for a stale-link migrate.
    useEffect(() => {
        cleanUrl({ llz: llzParam }, {
            deprecated: { v: parseLegacyV },
        })
    }, [])

    // Pre-fetch the v2 manifest so we can derive a sensible initial
    // viewport from the county/muni bbox before the user has moved the
    // map. Otherwise the picker's no-viewport fallback (r6 single-file)
    // gives us only ~14 hexes for Hudson — not granular enough.
    const [v2Manifest, setV2Manifest] = useState<MapManifestV2 | null>(null)
    useEffect(() => {
        loadManifestV2().then(m => { if (m) setV2Manifest(m) }).catch(() => {})
    }, [])

    // Camera override: per-county hand-tuned views apply on both the embed
    // and the full-screen route; the statewide hand-tuned view is
    // full-screen only (the short embed wants the height-appropriate bbox
    // auto-fit). Muni views always auto-fit from the muni bbox.
    const initialView =
        cc !== null && mc === null ? (LLZ_OVERRIDES[cc] ?? null)
        : cc === null && fullScreen ? STATEWIDE_VIEW
        : null

    // Approximate the section's visible viewport. Priority:
    //   1. live `llz` (round-tripped from CrashMap's viewState via URL)
    //   2. the hand-tuned `initialView` override (lerped by width) — keeps
    //      the fetch viewport aligned with the camera the user sees
    //   3. synthetic viewState from county/muni bbox via `fitBoundsToView`
    //   4. null (unknown — picker falls back to r6 single-file)
    const effectiveView: ViewState | null = useMemo(() => {
        if (llz) return llz
        const [w, h] = viewportDims(fullScreen)
        if (initialView) return lerpView(initialView, w)
        const bbox: [number, number, number, number] | undefined =
            cc !== null && mc !== null ? v2Manifest?.muni_bboxes?.[`${cc}-${mc}`]
            : cc !== null ? v2Manifest?.county_bboxes?.[cc]
            : STATE_BBOX
        if (!bbox) return null
        return fitBoundsToView(bbox, w, h, mode === "hexbin" ? 45 : 0)
    }, [llz, cc, mc, mode, v2Manifest, fullScreen, initialView])

    // Effective hex-pixel target. When `hexAuto` is on, look up the
    // preferred H3 resolution for the current integer zoom, then set the
    // target to that resolution's on-screen diameter (× 0.99 for slack).
    // This is a `Record<zoom, res>` calibration table — much easier to
    // reason about than fitting a curve through anchor points, and lets
    // us tune each zoom step independently.
    //
    // Math: `hex_px(z, lat, r) = 2 × H3_RADIUS_METERS[r] × 2^z /
    // (156543 × cos(lat))`. Fully deterministic; only latitude (NJ
    // range 39-41°) varies materially. VP size doesn't factor in —
    // that's what makes this stable across the embed + full-screen.
    //
    // Density-adaptive would feedback-loop (hexPxTarget → picker res →
    // cells → hexPxTarget), so intentionally ignored here.
    const circleRadiusPxValue = useMemo(
        () => circleRadiusPx(effectiveView?.zoom ?? 7),
        [effectiveView?.zoom],
    )

    const hexPxTarget = useMemo(() => {
        if (!hexAuto) return manualHexPx
        const [vpw, vph] = viewportDims(fullScreen)
        return hexPxTargetFor(viz, vpw * vph, binsBudget)
    }, [viz, hexAuto, manualHexPx, fullScreen, binsBudget])

    // Picker-state snapshot: current H3 resolution + adjacent levels
    // (one coarser, one finer) as clickable jump targets. Neighbors that
    // don't exist (below r0 / above r15) are omitted from the carousel.
    const pickerInfo = useMemo(() => {
        if (!effectiveView) return null
        const { zoom, latitude } = effectiveView
        const mppx = metersPerPixel(zoom, latitude)
        const currRes = pickHexResolutionForPixels(hexPxTarget, zoom, latitude)
        const pxAt = (r: number): number | null => {
            const rad = H3_RADIUS_METERS[r]
            if (rad === undefined) return null
            return (2 * rad) / mppx
        }
        const levels: { res: number, px: number, isCurrent: boolean }[] = []
        for (const res of [currRes - 1, currRes, currRes + 1]) {
            const px = pxAt(res)
            if (px !== null) levels.push({ res, px, isCurrent: res === currRes })
        }
        return { levels }
    }, [effectiveView, hexPxTarget])

    // S2 counterpart to `pickerInfo.currRes` — computed regardless of
    // active grid so the widget can show what an S2 fetch WOULD pick,
    // even while `?grid=h3` is still driving the actual fetch. Costs
    // nothing to compute (pure math on the `S2_DIAMETER_METERS` table).
    const s2Level = useMemo(() => {
        if (!effectiveView) return null
        return pickS2LevelForPixels(hexPxTarget, effectiveView.zoom, effectiveView.latitude)
    }, [effectiveView, hexPxTarget])

    const filter: CrashFilter = useMemo(() => {
        const base: CrashFilter = {
            yearRange,
            ccs: cc !== null ? [cc] : undefined,
            mc: mc ?? undefined,
            severities,
            pointZoomThreshold,
            maxPointShards,
            maxHexShards,
        }
        if (!effectiveView) return base
        const [w, h] = viewportDims(fullScreen)
        return {
            ...base,
            viewport: bboxFromViewport(effectiveView.latitude, effectiveView.longitude, effectiveView.zoom, w, h, effectiveView.pitch),
            viewportLat: effectiveView.latitude,
            zoom: effectiveView.zoom,
            hexPxTarget,
        }
    }, [yearRange, cc, mc, severities, effectiveView, hexPxTarget, pointZoomThreshold, maxPointShards, maxHexShards, fullScreen])

    const [outline, setOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        const url = cc === null
            ? `${MAP_BASE_URL}/counties.geojson`
            : `${MAP_BASE_URL}/counties/${String(cc).padStart(2, "0")}.geojson`
        fetch(url).then(r => r.ok ? r.json() : null).then(setOutline).catch(() => setOutline(null))
    }, [cc])
    // Muni outline: only when a muni is selected. File is ~30-130 KB/county;
    // filter client-side to the single feature matching our mc.
    const [muniOutline, setMuniOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        if (cc === null || mc === null) { setMuniOutline(null); return }
        const url = `${MAP_BASE_URL}/munis/${String(cc).padStart(2, "0")}.geojson`
        let cancelled = false
        fetch(url)
            .then(r => r.ok ? r.json() as Promise<FeatureCollection> : null)
            .then(fc => {
                if (cancelled || !fc) { if (!cancelled) setMuniOutline(null); return }
                const feat = fc.features.find(f => f.properties?.mc === mc)
                setMuniOutline(feat ? { type: "FeatureCollection", features: [feat] } : null)
            })
            .catch(() => { if (!cancelled) setMuniOutline(null) })
        return () => { cancelled = true }
    }, [cc, mc])

    // Data fetch goes through the cells-api worker (`useCellsApi`).
    // `v2Manifest` (loaded separately above) carries the county/muni
    // bboxes the rest of the section needs.
    const apiFilter: CellsApiFilter | null = useMemo(() => {
        if (!filter?.viewport || filter.viewportLat == null || filter.zoom == null) return null
        // Pull a polygon for clipping when on county/muni scope. Prefer
        // the muni outline (tightest), then the county outline. Skip
        // statewide (no admin-boundary scope to clip to). The worker
        // drops cells whose center isn't in the polygon — eliminates
        // the visible spillover into NYC/Bergen and shrinks response
        // size enough to make r10/r11 viable for county views.
        // Wait for the outline GeoJSON to load before firing — otherwise
        // we'd fetch once unclipped (pulling in NYC etc.) and refetch
        // once it lands, doubling the round trips on first paint.
        if (mc !== null && !muniOutline) return null
        if (mc === null && cc !== null && !outline) return null
        const clipPolygon = mc !== null && muniOutline
            ? extractOuterRing(muniOutline)
            : cc !== null && outline
              ? extractOuterRing(outline)
              : undefined
        return {
            yearRange: filter.yearRange,
            severities: filter.severities ?? new Set(["f", "i", "p"]),
            viewport: filter.viewport,
            viewportLat: filter.viewportLat,
            zoom: filter.zoom,
            hexPxTarget: filter.hexPxTarget,
            clipPolygon,
            grid,
        }
    }, [filter, cc, mc, outline, muniOutline, grid])
    const apiResult = useCellsApi(apiFilter)
    const result = useMemo(() => {
        // Adapt the cells-api result into the shape consumers below expect.
        // `manifest` is the standalone v2-manifest state (loaded above for
        // bboxes/year_range); cells-api owns its own manifest internally.
        // Synthesize a FetchPlan with `kind:"hex"` + the API's actual res
        // so the debug overlay can highlight the row truly being rendered
        // (avoids the mismatch where renderRes picked finer than what the
        // API delivered under the cells cap).
        const manifest = v2Manifest
        const apiPlan = apiResult.plan
            ? ({
                kind: "hex" as const,
                res: apiResult.plan.res,
                shards: null,
                reason: apiResult.plan.reason,
                cellCount: apiResult.plan.cellCount,
                fetchedBytes: apiResult.plan.fetchedBytes,
            })
            : null
        // While refetching (debounced pan/zoom), keep showing the prior
        // cells if we have them — only flash through "loading" when there
        // is truly nothing to render.
        if (apiResult.status === "loading") {
            if (apiResult.data && apiResult.data.length > 0) {
                return {
                    status: "ready" as const,
                    data: apiResult.data,
                    dataKind: "hex" as const,
                    manifest: manifest!,
                    refetching: true,
                    plan: apiPlan,
                }
            }
            return { status: "loading" as const, manifest, plan: apiPlan }
        }
        if (apiResult.status === "error") {
            return { status: "error" as const, error: apiResult.error, manifest, plan: apiPlan }
        }
        return {
            status: "ready" as const,
            data: apiResult.data,
            dataKind: "hex" as const,
            manifest: manifest!,
            refetching: false,
            plan: apiPlan,
        }
    }, [apiResult, v2Manifest])

    // Level-change detection for the loading fade. Fade/desaturate the prior
    // bins only when the picker's *target* res actually changed (a zoom that
    // crossed a level boundary) — never on a pure pan (same res, new
    // viewport; the bins mostly stay put, so muting them is just noise). We
    // compare the live target res against the target res of the data
    // currently shown (tracked in a ref), so budget-coarsening (rendered res
    // < target res) doesn't read as a level change on every refetch.
    const targetRes = pickerInfo?.levels.find(l => l.isCurrent)?.res ?? null
    const shownTargetRes = useRef<number | null>(null)
    useEffect(() => {
        if (result.status === "ready" && !result.refetching && targetRes !== null) {
            shownTargetRes.current = targetRes
        }
    }, [result, targetRes])
    const resChanging = result.status === "ready" && result.refetching
        && shownTargetRes.current !== null && targetRes !== null
        && shownTargetRes.current !== targetRes

    // Worker handles budget enforcement via `?maxCells=`: dense shards
    // come back at a coarser res than requested. Client-side fallback
    // here is just a safety net (cumulative across shards may still
    // overshoot if shard splits + adaptive don't converge perfectly).
    //
    // Budget check is on the viewport-clipped set, not the full fetched
    // set: when the picker single-file-falls-back to statewide r9 (51
    // shards > maxHexShards), most of the 77k cells are off-screen.
    // Counting only in-viewport cells keeps r9 visible at z~9.5+ where
    // the viewport really only sees ~25k of them. We also hand the
    // viewport-clipped slice (with a small padding margin to avoid
    // edge pop-in mid-pan) to the renderer so it doesn't iterate the
    // statewide tail each frame.
    const renderHexes = useMemo<{ hexes: StackedHex[]; res: number; coarsenedFrom: number | null } | null>(() => {
        if (result.status !== "ready" || result.dataKind !== "hex") return null
        const data = result.data as StackedHex[]
        if (data.length === 0) return { hexes: data, res: result.plan?.kind === "hex" ? result.plan.res : 9, coarsenedFrom: null }
        const sourceRes = getResolution(data[0].h3)
        const vp = filter.viewport
        const clip = (xs: StackedHex[]) => {
            if (!vp) return xs
            const padLon = (vp[2] - vp[0]) * 0.25
            const padLat = (vp[3] - vp[1]) * 0.25
            const lo0 = vp[0] - padLon, hi0 = vp[2] + padLon
            const lo1 = vp[1] - padLat, hi1 = vp[3] + padLat
            return xs.filter(h => h.center[0] >= lo0 && h.center[0] <= hi0 && h.center[1] >= lo1 && h.center[1] <= hi1)
        }
        let inViewport = clip(data)
        if (inViewport.length <= CELLS_BUDGET) return { hexes: inViewport, res: sourceRes, coarsenedFrom: null }
        let res = sourceRes
        let out = data
        while (inViewport.length > CELLS_BUDGET && res > 5) {
            res--
            out = coarsenHexes(data, res)
            inViewport = clip(out)
        }
        return { hexes: inViewport, res, coarsenedFrom: sourceRes }
    }, [result, filter.viewport])

    const initialBounds: [number, number, number, number] = useMemo(() => {
        const m = result.manifest
        if (cc !== null && mc !== null) {
            const mb = m?.muni_bboxes?.[`${cc}-${mc}`]
            if (mb) return mb
        }
        if (cc !== null && m?.county_bboxes?.[cc]) return m.county_bboxes[cc]
        return STATE_BBOX
    }, [cc, mc, result.manifest])

    const bg = actualTheme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = actualTheme === "dark" ? "#e0e0e0" : "#333"
    const activeBg = actualTheme === "dark" ? "#6db3f2" : "#0066cc"

    const [y0min, y1max] = result.manifest?.year_range ?? [2001, 2023]

    const emptySeverities = severities.size === 0

    const toggleSeverity = (s: "f" | "i" | "p") => {
        const next = new Set(severities)
        if (next.has(s)) next.delete(s); else next.add(s)
        setSeverities(next)
    }
    const severityPhrase = formatSeverityPhrase(severities)

    // Pitch / bearing camera sliders. Read from the effective view; write
    // through `llz` — which, on first use, commits the override/auto-fit
    // view (so lat/lon/zoom stay put while only the tilt/rotation moves).
    const pitch = effectiveView?.pitch ?? 45
    const bearing = effectiveView?.bearing ?? 0
    const setPitch = (p: number) => { if (effectiveView) setLlz({ ...effectiveView, pitch: p }) }
    const setBearing = (b: number) => { if (effectiveView) setLlz({ ...effectiveView, bearing: b }) }

    // Close drawer on map click — but not on map drag/pan. Track the
    // pointerdown position; if pointerup happens within a small movement
    // threshold, treat it as a click and close. Otherwise it was a pan
    // and we leave the drawer open.
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const drawerRef = useRef<HTMLDivElement | null>(null)
    // Hovered res from the debug drawer's h3-cells table; shows an
    // outline-only hex grid at that res on the map.
    const [gridOverlayRes, setGridOverlayRes] = useState<number | null>(null)

    // Persist user-driven height changes from CSS `resize: vertical`.
    // ResizeObserver fires after the DOM commit; debounce a tick so we
    // don't thrash SS during the drag. Bail when the height matches our
    // controlled value (avoid feedback when *we* set it).
    useEffect(() => {
        // Full-screen fills the viewport — no drag-resize handle to track.
        if (fullScreen) return
        const el = wrapRef.current
        if (!el) return
        let t: number | null = null
        const ro = new ResizeObserver(entries => {
            const h = Math.round(entries[0].contentRect.height)
            if (h === mapHeight || h <= 0) return
            if (t !== null) window.clearTimeout(t)
            t = window.setTimeout(() => setMapHeight(h), 80)
        })
        ro.observe(el)
        return () => { ro.disconnect(); if (t !== null) window.clearTimeout(t) }
    }, [mapHeight, setMapHeight, fullScreen])

    const heightOverridden = !fullScreen && mapHeight !== defaultHeight
    const showResetButton = !!llz || heightOverridden
    const resetView = () => {
        if (llz) setLlz(null)
        if (heightOverridden) setMapHeight(defaultHeight)
    }
    useEffect(() => {
        if (!drawerOpen) return
        let downAt: { x: number; y: number; target: Element | null } | null = null
        const onDown = (e: PointerEvent) => {
            const target = e.target as Element | null
            const wrap = wrapRef.current
            const drawer = drawerRef.current
            if (!target || !wrap || !wrap.contains(target)) { downAt = null; return }
            // Click was inside the drawer itself — don't close.
            if (drawer && drawer.contains(target)) { downAt = null; return }
            if (target.closest("button, a, label, input, select, textarea")) { downAt = null; return }
            downAt = { x: e.clientX, y: e.clientY, target }
        }
        const onUp = (e: PointerEvent) => {
            if (!downAt) return
            const dx = e.clientX - downAt.x
            const dy = e.clientY - downAt.y
            downAt = null
            if (dx * dx + dy * dy > 25) return  // moved >5px → pan, not click
            setDrawerOpen(false)
        }
        window.addEventListener("pointerdown", onDown, true)
        window.addEventListener("pointerup", onUp, true)
        return () => {
            window.removeEventListener("pointerdown", onDown, true)
            window.removeEventListener("pointerup", onUp, true)
        }
    }, [drawerOpen, setDrawerOpen])

    // Header content (severity phrase · scope · year selects). Rendered
    // above the panel in embed mode, or as a top-center overlay pill in
    // full-screen mode (where there's no "above the map").
    // Header content (severity phrase · scope · year range). In embed
    // mode the page-level top-nav owns the year-range dropdowns, so we
    // just show the range as text to avoid a duplicate control. In
    // fullscreen mode (the `/map` route, no top nav), keep the
    // interactive `YearSelect` dropdowns.
    const headerInner = (
        <>
            <span>{severityPhrase} crashes</span>
            {scopeLabel && <><span>·</span><span>{scopeLabel}</span></>}
            <span>·</span>
            {fullScreen ? (
                <>
                    <YearSelect
                        value={yearRange[0]} min={y0min} max={yearRange[1]}
                        onChange={y => setYearRange([y, yearRange[1]])}
                        theme={actualTheme}
                    />
                    <span>–</span>
                    <YearSelect
                        value={yearRange[1]} min={yearRange[0]} max={y1max}
                        onChange={y => setYearRange([yearRange[0], y])}
                        theme={actualTheme}
                    />
                </>
            ) : (
                <span>{yearRange[0]}–{yearRange[1]}</span>
            )}
        </>
    )

    return (
        <>
            {!fullScreen && (
                <div style={{
                    textAlign: "center", color: "var(--text-secondary)",
                    marginTop: "-0.3em", marginBottom: "0.4em",
                    display: "flex", flexWrap: "wrap", alignItems: "center",
                    justifyContent: "center", gap: 6, fontSize: "0.95em",
                }}>
                    {headerInner}
                </div>
            )}
        <div
            ref={wrapRef}
            style={fullScreen ? {
                position: "relative", height: "100vh", width: "100vw",
                overflow: "hidden",
            } : {
                position: "relative", height: mapHeight, width: "100%",
                borderRadius: 4, overflow: "hidden",
                resize: "vertical", minHeight: 240, maxHeight: 1200,
            }}
        >
            {fullScreen && (
                <div style={{
                    position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
                    zIndex: 50, background: bg, color: fg,
                    padding: "3px 10px", borderRadius: 4,
                    border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                    display: "flex", flexWrap: "wrap", alignItems: "center",
                    justifyContent: "center", gap: 6, fontSize: "0.8em",
                    maxWidth: "calc(100% - 16px)",
                }}>
                    {headerInner}
                </div>
            )}
            {result.status === "error" && (
                <div style={{ padding: "1em", color: "red" }}>Error: {result.error}</div>
            )}
            {result.status === "loading" && <LoadingOverlay theme={actualTheme} />}
            {result.status === "ready" && (() => {
                return (
                <Suspense fallback={<LoadingOverlay theme={actualTheme} />}>
                    <CrashMap
                        prebinnedHexes={renderHexes?.hexes ?? (result.data as StackedHex[])}
                        outline={outline ?? undefined}
                        muniOutline={muniOutline ?? undefined}
                        initialBounds={initialBounds}
                        initialView={initialView}
                        viewState={llz ?? undefined}
                        onViewStateChange={setLlz}
                        onOutlineClick={onOutlineClick}
                        mode="hexbin"
                        theme={actualTheme}
                        height={fullScreen ? "100%" : mapHeight}
                        showInternalControls={false}
                        hexPxTarget={hexPxTarget}
                        onHexPxTargetChange={setHexPxTarget}
                        heightScale={heightScale}
                        onHeightScaleChange={setHeightScale}
                        gridOverlayRes={drawerOpen ? gridOverlayRes : null}
                        coverCells={drawerOpen && debugOpen ? apiResult.plan?.cover ?? null : null}
                        viz={viz}
                        circleRadiusPx={circleRadiusPxValue}
                        hexOpacity={resChanging ? 0.35 : 1}
                        hexDesaturate={resChanging ? 0.55 : 0}
                    />
                </Suspense>
                )
            })()}
            {result.status === "ready" && result.refetching && !drawerOpen && <RefetchSpinner theme={actualTheme} />}
            {!drawerOpen && (
                <>
                    <button
                        onClick={() => setDrawerOpen(true)}
                        title="Show controls"
                        aria-label="Show map controls"
                        style={{
                            position: "absolute", top: 8, right: 8, background: bg, color: fg,
                            padding: "0.25em 0.5em", borderRadius: 4, zIndex: 50,
                            border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                            cursor: "pointer", fontSize: "1em", lineHeight: 1,
                        }}
                    >⚙</button>
                    {showResetButton && (
                        <button
                            onClick={resetView}
                            title={llz && heightOverridden ? "Reset view + height" : llz ? "Reset view" : "Reset height"}
                            aria-label="Reset map view"
                            style={{
                                position: "absolute", top: 8, right: 40, background: bg, color: fg,
                                width: 24, height: 24, padding: 0, borderRadius: 4, zIndex: 50,
                                border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                                cursor: "pointer", fontSize: "0.95em", lineHeight: 1,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                            }}
                        >↺</button>
                    )}
                </>
            )}
            {drawerOpen && (
            <div ref={drawerRef} style={{
                position: "absolute", top: 8, right: 8, background: bg, color: fg,
                padding: "0.4em 0.6em", borderRadius: 4, zIndex: 50, fontSize: "0.82em",
                display: "flex", flexDirection: "column", gap: 6, minWidth: 210, maxWidth: 260,
                maxHeight: "calc(100% - 16px)", overflowY: "auto",
            }}>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, alignItems: "center", marginBottom: -4 }}>
                    {result.status === "ready" && result.refetching && (
                        <div style={{ marginRight: "auto", display: "flex", alignItems: "center" }}
                             title="Refreshing map data…">
                            <SpinnerCircle theme={actualTheme} size={13} />
                        </div>
                    )}
                    {showResetButton && (
                        <button
                            onClick={resetView}
                            title={llz && heightOverridden ? "Reset view + height" : llz ? "Reset view" : "Reset height"}
                            aria-label="Reset map view"
                            style={{
                                background: "transparent", color: fg, border: "none",
                                cursor: "pointer", fontSize: "0.95em", padding: "0 0.2em", lineHeight: 1,
                            }}
                        >↺</button>
                    )}
                    <button
                        onClick={() => setDrawerOpen(false)}
                        title="Hide controls"
                        aria-label="Hide map controls"
                        style={{
                            background: "transparent", color: fg, border: "none",
                            cursor: "pointer", fontSize: "1em", padding: "0 0.2em", lineHeight: 1,
                        }}
                    >×</button>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                    {(["scatter", "heatmap", "hexbin"] as MapMode[]).map(m => (
                        <button
                            key={m}
                            onClick={() => setMode(m)}
                            style={{
                                padding: "0.2em 0.5em",
                                cursor: "pointer",
                                background: mode === m ? activeBg : "transparent",
                                color: mode === m ? "#fff" : fg,
                                border: `1px solid ${mode === m ? activeBg : fg}`,
                                borderRadius: 3,
                                fontSize: "0.85em",
                                flex: 1,
                            }}
                        >{m === "scatter" ? "Points" : m === "heatmap" ? "Heatmap" : "Hexbin"}</button>
                    ))}
                </div>
                {mode === "hexbin" && (
                    <>
                        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                            {(["hex", "circle"] as const).map(v => (
                                <button
                                    key={v}
                                    onClick={() => setViz(v)}
                                    style={{
                                        cursor: "pointer",
                                        background: viz === v ? activeBg : "transparent",
                                        color: viz === v ? "#fff" : fg,
                                        border: `1px solid ${viz === v ? activeBg : fg}`,
                                        borderRadius: 3,
                                        padding: "2px 8px",
                                        fontSize: "0.78em",
                                        flex: 1,
                                    }}
                                >{v === "hex" ? "Hex" : "Circle"}</button>
                            ))}
                        </div>
                        <HexPxTargetSlider
                            value={hexPxTarget}
                            onChange={setHexPxTarget}
                            auto={hexAuto}
                            onAutoChange={setHexAuto}
                            pickerInfo={pickerInfo}
                            zoom={effectiveView?.zoom}
                        />
                        <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                            <span style={{ fontSize: "0.78em" }}>Height scale: <b>{heightScale.toFixed(2)}</b></span>
                            <input
                                type="range" min={0} max={1} step={0.05}
                                value={heightScale}
                                onChange={e => setHeightScale(Number(e.target.value))}
                                style={{ width: 100 }}
                            />
                        </label>
                        <NumberSlider
                            label="Pitch" unit="°" min={0} max={85} step={1}
                            value={pitch} onChange={setPitch}
                            defaultValue={45} reset={() => setPitch(45)}
                        />
                        <NumberSlider
                            label="Bearing" unit="°" min={0} max={360} step={1}
                            value={bearing} onChange={setBearing}
                            defaultValue={0} reset={() => setBearing(0)}
                        />
                        <ZoomResChart
                            currentZoom={effectiveView?.zoom ?? 7}
                            currentLat={effectiveView?.latitude ?? 40.7}
                            currentRes={pickerInfo?.levels.find(l => l.isCurrent)?.res ?? 11}
                            grid={grid}
                            s2Level={s2Level}
                            viz={viz}
                            viewportAreaPx={(() => { const [w, h] = viewportDims(fullScreen); return w * h })()}
                            budget={binsBudget}
                            fetched={result.status === "ready" && result.plan?.kind === "hex" ? result.plan.cellCount : undefined}
                            fetchedBytes={result.status === "ready" && result.plan?.kind === "hex" ? result.plan.fetchedBytes : undefined}
                            inViewport={renderHexes?.hexes.length}
                            actualVp={typeof window !== "undefined" ? [window.innerWidth, window.innerHeight] : undefined}
                            clampedVp={viewportDims(fullScreen)}
                            targetPx={hexPxTarget}
                        />
                    </>
                )}
                <DebugSection
                    open={debugOpen}
                    onToggle={() => setDebugOpen(!debugOpen)}
                    theme={actualTheme}
                    fg={fg}
                >
                    <div style={{
                        padding: "4px 8px",
                        marginBottom: 6,
                        border: `1px solid ${actualTheme === "dark" ? "#6db3f2" : "#0066cc"}`,
                        borderRadius: 3,
                        fontSize: "0.78em",
                        color: actualTheme === "dark" ? "#6db3f2" : "#0066cc",
                    }}>
                        cells-api — {apiResult.plan
                            ? `${apiResult.plan.source} r${apiResult.plan.res}, ${apiResult.plan.cellCount ?? "—"} cells`
                            : apiResult.status}
                    </div>
                    {effectiveView && (() => {
                        const renderRes = pickHexResolutionForPixels(hexPxTarget, effectiveView.zoom, effectiveView.latitude)
                        const planRes = result.plan?.res ?? null
                        // `coarsenHexes` no-ops when target ≥ source (can't
                        // refine), so what we actually display is `min` of
                        // the two — never finer than what the data provides.
                        const effectiveRes = planRes !== null ? Math.min(renderRes, planRes) : renderRes
                        return (
                            <DebugOverlay
                                viewState={effectiveView}
                                plan={(() => {
                                    if (!result.plan) return null
                                    if (result.plan.kind !== "hex" || !renderHexes?.coarsenedFrom) return result.plan
                                    return {
                                        ...result.plan,
                                        reason: `${result.plan.reason ?? `r${result.plan.res}`} · coarsened r${renderHexes.coarsenedFrom}→r${renderHexes.res} (budget ${CELLS_BUDGET / 1000}k)`,
                                    }
                                })()}
                                renderRes={renderRes}
                                effectiveRes={renderHexes?.res ?? effectiveRes}
                                hexPxTarget={hexPxTarget}
                                rowCount={
                                    renderHexes?.hexes.length
                                    ?? (result.status === "ready" ? result.data.length : undefined)
                                }
                                fetchState={
                                    result.status === "loading" ? "loading"
                                    : result.status === "ready" && result.refetching ? "refetching"
                                    : "idle"
                                }
                                onHoverRes={setGridOverlayRes}
                                theme={actualTheme}
                            />
                        )
                    })()}
                    <div style={{ marginTop: 6, color: actualTheme === "dark" ? "#888" : "#666", fontSize: "0.78em" }}>picker knobs</div>
                    <NumberSlider
                        label="point z-thresh" min={8} max={15} step={0.5}
                        value={pointZoomThreshold} onChange={setPointZoomThreshold}
                        defaultValue={11} reset={() => setPointZoomThreshold(11)}
                    />
                    <NumberSlider
                        label="max pt shards" min={1} max={50} step={1}
                        value={maxPointShards} onChange={setMaxPointShards}
                        defaultValue={10} reset={() => setMaxPointShards(10)}
                    />
                    <NumberSlider
                        label="max hex shards" min={1} max={200} step={1}
                        value={maxHexShards} onChange={setMaxHexShards}
                        defaultValue={100} reset={() => setMaxHexShards(100)}
                    />
                </DebugSection>
            </div>
            )}
            {/* "Back to charts" (fullscreen) / "Open full-screen" (embed) lives
             *  bottom-left so it doesn't collide with the Legend (top-left),
             *  scope pill (top-center), drawer (top-right), or use-kbd's
             *  SpeedDial (viewport's bottom-right). */}
            {(fullScreen ? detailsHref : fullScreenHref) && (
                <a
                    href={(fullScreen ? detailsHref : fullScreenHref) as string}
                    title={fullScreen ? "Back to charts" : "Open full-screen"}
                    aria-label={fullScreen ? "Back to charts view" : "Open map in full-screen view"}
                    style={{
                        position: "absolute", bottom: 8, left: 8, zIndex: 50,
                        background: bg, color: fg,
                        padding: "0.3em", borderRadius: 4,
                        border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        textDecoration: "none", lineHeight: 1,
                    }}
                >
                    {fullScreen ? <FiMinimize2 size={14} /> : <FiMaximize2 size={14} />}
                </a>
            )}
            <Legend
                theme={actualTheme}
                severities={severities}
                onToggle={toggleSeverity}
            />
            {emptySeverities && result.status === "ready" && (
                <div style={{
                    position: "absolute", inset: 0, zIndex: 45,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: actualTheme === "dark" ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.5)",
                    color: fg, fontSize: "0.9em", pointerEvents: "none",
                }}>
                    <div style={{
                        background: bg, padding: "0.5em 0.8em", borderRadius: 4,
                        border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                    }}>
                        Select at least one severity
                    </div>
                </div>
            )}
        </div>
        </>
    )
}

function formatSeverityPhrase(severities: Set<"f" | "i" | "p">): string {
    if (severities.size === 0) return "No"
    if (severities.size === 3) return "All reported"
    const parts: string[] = []
    if (severities.has("f")) parts.push("Fatal")
    if (severities.has("i")) parts.push("Injury")
    if (severities.has("p")) parts.push("Other")
    if (parts.length === 1) return parts[0]
    if (parts.length === 2) return `${parts[0]} & ${parts[1].toLowerCase()}`
    return parts.join(", ")
}

function LoadingOverlay({ theme }: { theme: "light" | "dark" }) {
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const border = theme === "dark" ? "#666" : "#888"
    const keyframes = `@keyframes hccs-spin { to { transform: rotate(360deg) } }`
    return (
        <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 8, color: fg,
            fontSize: "0.9em",
        }}>
            <style>{keyframes}</style>
            <div style={{
                width: 24, height: 24, borderRadius: "50%",
                border: `2px solid ${border}`, borderTopColor: "transparent",
                animation: "hccs-spin 0.8s linear infinite",
            }} />
            <div>Loading map…</div>
        </div>
    )
}

/** Bare spinning ring. Caller positions it (corner overlay or inline in
 *  the drawer header). */
function SpinnerCircle({ theme, size = 16 }: { theme: "light" | "dark"; size?: number }) {
    const border = theme === "dark" ? "#aaa" : "#555"
    return (
        <>
            <style>{`@keyframes hccs-spin { to { transform: rotate(360deg) } }`}</style>
            <div style={{
                width: size, height: size, borderRadius: "50%", flexShrink: 0,
                border: `2px solid ${border}`, borderTopColor: "transparent",
                animation: "hccs-spin 0.8s linear infinite",
            }} />
        </>
    )
}

/** Subtle top-right spinner shown while a background refetch is in flight
 *  (e.g. zoom crossed a hex-resolution threshold). Used only when the
 *  controls drawer is closed — when open, the spinner moves into the
 *  drawer header (the open drawer would otherwise occlude `right: 72`). */
function RefetchSpinner({ theme }: { theme: "light" | "dark" }) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.6)" : "rgba(255,255,255,0.7)"
    return (
        <div style={{
            // `right: 72` clears the ⚙ gear (right: 8) and ↺ reset
            // (right: 40) buttons shown when the drawer is closed.
            position: "absolute", top: 8, right: 72, zIndex: 50,
            width: 24, height: 24, borderRadius: "50%", padding: 4,
            background: bg, pointerEvents: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
        }}>
            <SpinnerCircle theme={theme} size={16} />
        </div>
    )
}

function Legend({
    theme, severities, onToggle,
}: {
    theme: "light" | "dark"
    severities: Set<"f" | "i" | "p">
    onToggle: (s: "f" | "i" | "p") => void
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.85)" : "rgba(255,255,255,0.9)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const items: { key: "f" | "i" | "p"; label: string; color: string }[] = [
        { key: "f", label: "Fatal",  color: "rgb(239,68,68)" },
        { key: "i", label: "Injury", color: "rgb(245,158,11)" },
        { key: "p", label: "Other",  color: "rgb(220,200,90)" },
    ]
    return (
        <div style={{
            position: "absolute", top: 8, left: 8, zIndex: 50,
            background: bg, color: fg, padding: "4px 8px", borderRadius: 4,
            fontSize: "0.72em", display: "flex", flexDirection: "column", gap: 2,
            border: `1px solid ${theme === "dark" ? "#444" : "#ccc"}`,
        }}>
            {items.map(it => {
                const on = severities.has(it.key)
                return (
                    <button
                        key={it.key}
                        title={on ? `Hide ${it.label}` : `Show ${it.label}`}
                        aria-pressed={on}
                        onClick={() => onToggle(it.key)}
                        style={{
                            display: "flex", alignItems: "center", gap: 6,
                            opacity: on ? 1 : 0.4,
                            background: "transparent", color: fg, border: "none", padding: 0,
                            cursor: "pointer",
                            font: "inherit", textAlign: "left",
                        }}
                    >
                        <span style={{
                            display: "inline-block", width: 10, height: 10,
                            background: it.color, borderRadius: 2,
                        }} />
                        <span>{it.label}</span>
                    </button>
                )
            })}
        </div>
    )
}

/** Drawer widget: 2D chart mapping map-zoom (left axis) to hex-px
 *  size in each of three H3 resolution columns (prev / current / next).
 *
 *  Y-axis (linear in zoom): integer zoom labels on the left. Range =
 *  current zoom ±3.5 — cursor stays centered, ticks slide smoothly.
 *
 *  For each res column: ticks at round pixel sizes (1, 2, 4, 8, 16,
 *  32 px), positioned at the *fractional* zoom that produces exactly
 *  that px for that resolution+latitude:
 *      px = 2 × H3_RADIUS_METERS[r] / mppx
 *      z_at(px, r) = log2( px × 156543 × cos(lat) / (2 × H3_R[r]) )
 *  Since res r+1's cell is ~1/2.65 × of res r, the same round px sits
 *  at a lower zoom in the finer col. Rows are intentionally *not*
 *  v-aligned across cols — that mismatch IS the point of the chart.
 *
 *  Horizontal orange line: the camera's current zoom, so users see
 *  where they are in the mapping at a glance. */
function ZoomResChart({
    currentZoom, currentLat, currentRes, grid, s2Level, viz, viewportAreaPx, budget,
    fetched, fetchedBytes, inViewport, actualVp, clampedVp, targetPx,
}: {
    currentZoom: number
    currentLat: number
    currentRes: number
    /** Active grid (`h3`/`s2`) from the `?grid=` URL param. When `s2`
     *  the H3 zoom×res chart still renders (as the shipping fetch path),
     *  and a small S2 row is appended below showing what an S2 fetch
     *  WOULD pick. Fetch swap is phase 4. */
    grid?: "h3" | "s2"
    /** S2 level the picker would select at this zoom/vp/budget. Shown
     *  next to the grid indicator when `grid === "s2"` (or always, as
     *  a preview even when H3 is active — decided by the widget). */
    s2Level?: number | null
    viz: "hex" | "circle"
    viewportAreaPx: number
    budget: number
    /** Total cells returned across all `/v1/cells` shards for this view
     *  (pre viewport-clip). Undefined while fetch is in flight. */
    fetched?: number
    /** Sum of unique batch-response body sizes (bytes) for this view. */
    fetchedBytes?: number
    /** Cells kept after client-side viewport clip → what actually
     *  renders. Diverges from `fetched` when the fetched cover extends
     *  past the visible bbox. */
    inViewport?: number
    /** Actual browser viewport `[innerWidth, innerHeight]` — for the
     *  embed clamp display. */
    actualVp?: [number, number]
    /** Post-clamp viewport `[w, h]` used by the picker. Shown alongside
     *  actualVp when they differ (embed mode clamps to `[1280, 480]`). */
    clampedVp?: [number, number]
    /** The picker's target hex-diameter (px), post-clamp. Surfaced so a
     *  wrong render is diagnosable from one screenshot. */
    targetPx?: number
}) {
    const H = 180  // chart height in px
    // Center the current zoom in the window; ticks slide smoothly as
    // zoom changes, rather than jumping when the camera crosses an
    // integer-zoom boundary. Window half-width = 3.5 zoom units, so
    // ~7 integer zooms visible at any time.
    const halfWin = 3.5
    const zMin = currentZoom - halfWin
    const zMax = currentZoom + halfWin
    const yFor = (z: number) => ((zMax - z) / (zMax - zMin)) * H
    const cosLat = Math.cos(currentLat * Math.PI / 180)
    const zForPxRes = (px: number, r: number): number =>
        Math.log2((px * 156543 * cosLat) / (2 * H3_RADIUS_METERS[r]))

    const roundPx = [0.5, 1, 2, 4, 8, 16, 32]
    const resCols = [currentRes - 1, currentRes, currentRes + 1].filter(r => r in H3_RADIUS_METERS)
    const intZooms: number[] = []
    for (let z = Math.ceil(zMin); z <= Math.floor(zMax); z++) intZooms.push(z)

    // Res-transition zooms in the visible window: scan for boundaries where
    // the auto picker flips from r{N} → r{N±1}, so the user can see where
    // pan/zoom will trigger a fetch at a different res (and 20s of new
    // wide-viewport /cells work). Binary-search each 0.1-zoom step where a
    // transition is detected to nail the boundary to ~0.005-zoom precision.
    const transitions: { z: number; from: number; to: number }[] = []
    const coarseStep = 0.1
    let prevRes = pickRes(viz, zMin, currentLat, viewportAreaPx, budget)
    for (let z = zMin + coarseStep; z <= zMax + 1e-9; z += coarseStep) {
        const r = pickRes(viz, z, currentLat, viewportAreaPx, budget)
        if (r !== prevRes) {
            let lo = z - coarseStep, hi = z
            for (let i = 0; i < 8; i++) {
                const mid = (lo + hi) / 2
                if (pickRes(viz, mid, currentLat, viewportAreaPx, budget) === prevRes) lo = mid
                else hi = mid
            }
            transitions.push({ z: (lo + hi) / 2, from: prevRes, to: r })
            prevRes = r
        }
    }

    const zoomColW = 32
    const resColW = 46
    const W = zoomColW + resColW * resCols.length + 8

    // Metrics block: fetched cells + bytes for this view, cells that
    // actually render (viewport-clipped), and the viewport clamp that
    // fed the picker. `fetched` is the pre-clip cover total, so a big
    // `fetched → inViewport` drop means the cover extends past the
    // visible bbox.
    const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
    const fmtKB = (b: number) => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`
    const vpClamped = actualVp && clampedVp && (actualVp[0] !== clampedVp[0] || actualVp[1] !== clampedVp[1])

    return (
        <div style={{
            marginTop: 4, paddingTop: 4, borderTop: "1px solid rgba(128,128,128,0.25)",
            fontSize: "0.85em", opacity: 0.9,
        }}>
            <div style={{
                opacity: 0.85, marginBottom: 4, lineHeight: 1.35,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}>
                <div>
                    fetched:{" "}
                    <span style={{ fontWeight: 600 }}>{fetched != null ? fmtN(fetched) : "…"}</span>
                    {" · "}
                    <span style={{ fontWeight: 600 }}>{fetchedBytes != null ? fmtKB(fetchedBytes) : "…"}</span>
                    {" · in-vp: "}
                    <span style={{ fontWeight: 600 }}>{inViewport != null ? fmtN(inViewport) : "…"}</span>
                </div>
                <div style={{ opacity: 0.7 }}>
                    vp:{" "}
                    {actualVp ? `${actualVp[0]}×${actualVp[1]}` : "?"}
                    {vpClamped && clampedVp && (
                        <span style={{ color: "#e0803a" }}>{` → ${clampedVp[0]}×${clampedVp[1]} (clamp)`}</span>
                    )}
                    {targetPx != null && (
                        <>
                            {" · target: "}
                            <span style={{ fontWeight: 600 }}>{targetPx.toFixed(1)}px</span>
                        </>
                    )}
                </div>
                {(grid || s2Level != null) && (
                    <div style={{ opacity: 0.7 }}>
                        grid: <span style={{ fontWeight: 600 }}>{grid ?? "h3"}</span>
                        {" · h3 r"}<span style={{ fontWeight: 600 }}>{currentRes}</span>
                        {s2Level != null && (
                            <>{" · s2 l"}<span style={{ fontWeight: 600 }}>{s2Level}</span></>
                        )}
                        {grid === "s2" && (
                            <span style={{ color: "#e0803a", marginLeft: 6 }}>(fetch: h3 — pending)</span>
                        )}
                    </div>
                )}
            </div>
            <div style={{ opacity: 0.55, marginBottom: 2, fontSize: "0.9em" }}>Zoom × hex px</div>
            <svg width={W} height={H + 18} style={{ overflow: "visible", display: "block" }}>
                {/* Column headers */}
                {resCols.map((r, i) => (
                    <text
                        key={r}
                        x={zoomColW + i * resColW + resColW / 2}
                        y={10}
                        fontSize={9}
                        textAnchor="middle"
                        fill="currentColor"
                        fontWeight={r === currentRes ? 700 : 400}
                        opacity={r === currentRes ? 1 : 0.7}
                    >r{r}</text>
                ))}
                {/* Integer zoom labels + horizontal guide lines */}
                {intZooms.map(z => (
                    <g key={z} transform={`translate(0, ${16 + yFor(z)})`}>
                        <text x={zoomColW - 2} y={3} fontSize={9} textAnchor="end" fill="currentColor" opacity={0.75}>
                            z={z}
                        </text>
                        <line
                            x1={zoomColW} x2={W}
                            y1={0} y2={0}
                            stroke="currentColor" strokeWidth={0.5} opacity={0.12}
                        />
                    </g>
                ))}
                {/* Per-res round-px ticks */}
                {resCols.map((r, i) => (
                    <g key={r} transform={`translate(${zoomColW + i * resColW}, 16)`}>
                        {roundPx.map(px => {
                            const z = zForPxRes(px, r)
                            if (z < zMin || z > zMax) return null
                            return (
                                <g key={px} transform={`translate(0, ${yFor(z)})`}>
                                    <line x1={0} x2={4} y1={0} y2={0} stroke="currentColor" opacity={0.6} strokeWidth={1} />
                                    <text x={7} y={3} fontSize={9} fill="currentColor" opacity={r === currentRes ? 0.95 : 0.55}>
                                        {px < 1 ? px.toFixed(1) : px}px
                                    </text>
                                </g>
                            )
                        })}
                    </g>
                ))}
                {/* Res-transition boundaries — where zooming will flip the
                 *  picker to a new res (and trigger a fresh /cells fetch at
                 *  a different data volume). Dashed cyan line + a small label
                 *  showing the direction (which res you land in going up
                 *  in zoom, i.e. into the region above the line). */}
                {transitions.map(t => (
                    <g key={t.z.toFixed(3)} transform={`translate(0, ${16 + yFor(t.z)})`}>
                        <line
                            x1={zoomColW} x2={W}
                            y1={0} y2={0}
                            stroke="#4dd0e1"
                            strokeWidth={1}
                            strokeDasharray="3 2"
                            opacity={0.75}
                        />
                        <text
                            x={W - 2} y={-2}
                            fontSize={8.5} textAnchor="end"
                            fill="#4dd0e1" opacity={0.9}
                        >↑ r{t.to}</text>
                    </g>
                ))}
                {/* Current-zoom marker */}
                <line
                    x1={zoomColW - 4} x2={W}
                    y1={16 + yFor(currentZoom)} y2={16 + yFor(currentZoom)}
                    stroke="orange" strokeWidth={1.25} opacity={0.85}
                />
                <text
                    x={zoomColW - 6}
                    y={16 + yFor(currentZoom) + 3}
                    fontSize={9} textAnchor="end" fill="orange" fontWeight={700}
                >{currentZoom.toFixed(1)}</text>
            </svg>
        </div>
    )
}

/** Direct-px slider for `hexPxTarget`. Log-spaced on a 0-100 abstract
 *  scale (so each tick is a constant log-px ratio), but always shows the
 *  actual px value alongside. Defaults to 1.2 px on first session use. */
function HexPxTargetSlider({
    value, onChange, auto, onAutoChange, pickerInfo, zoom,
}: {
    value: number
    onChange: (n: number) => void
    auto: boolean
    onAutoChange: (v: boolean) => void
    pickerInfo: {
        levels: { res: number, px: number, isCurrent: boolean }[],
    } | null
    zoom: number | undefined
}) {
    const MIN = 0.5, MAX = 30
    const toScale = (v: number) => 100 * (Math.log2(v / MIN) / Math.log2(MAX / MIN))
    const fromScale = (s: number) => MIN * Math.pow(MAX / MIN, s / 100)
    const sliderValue = Math.round(toScale(value))
    const fmtPx = (px: number | null) => px === null ? "–" : (px < 5 ? px.toFixed(1) : String(Math.round(px)))
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span style={{ fontSize: "0.88em", display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                        type="checkbox"
                        checked={auto}
                        onChange={e => onAutoChange(e.target.checked)}
                        title="Auto: grow hex px target with zoom (bigger hexes when zoomed in). Uncheck for manual control."
                        style={{ margin: 0 }}
                    />
                    Hex px: <b>{value < 5 ? value.toFixed(1) : Math.round(value)}</b>
                    {auto && <span style={{ opacity: 0.55, marginLeft: 2 }}>(auto)</span>}
                    {zoom !== undefined && (
                        <span style={{ opacity: 0.55, marginLeft: 4 }}>· z={zoom.toFixed(1)}</span>
                    )}
                </span>
                <input
                    type="range" min={0} max={100} step={1}
                    value={sliderValue}
                    disabled={auto}
                    onChange={e => {
                        const px = fromScale(Number(e.target.value))
                        const rounded = px < 5 ? Math.round(px * 10) / 10 : Math.round(px)
                        onChange(Math.max(MIN, Math.min(MAX, rounded)))
                    }}
                    style={{ width: 100, opacity: auto ? 0.4 : 1 }}
                />
            </label>
            {pickerInfo && (
                <div style={{
                    fontSize: "0.88em", opacity: 0.85, paddingLeft: 22, lineHeight: 1.3,
                    display: "flex", gap: 8, alignItems: "center",
                }}>
                    {pickerInfo.levels.map(({ res, px, isCurrent }) => isCurrent ? (
                        <span key={res}><b>r{res} · {fmtPx(px)}px</b></span>
                    ) : (
                        <button
                            key={res}
                            type="button"
                            onClick={() => {
                                // Under bins-budget the auto picker is
                                // deterministic from viewport area + budget,
                                // so per-zoom pinning doesn't compose. Set
                                // the target to this level's own px so the
                                // floor picker locks onto it, and drop out
                                // of auto — otherwise the manual value gets
                                // ignored on the next render.
                                onChange(Math.max(MIN, Math.min(MAX, px < 5 ? Math.round(px * 10) / 10 : Math.round(px))))
                                if (auto) onAutoChange(false)
                            }}
                            style={{
                                background: "none", border: "none", padding: 0, color: "inherit",
                                cursor: "pointer", textDecoration: "underline dotted",
                                font: "inherit", opacity: 0.75,
                            }}
                            title={`Snap to r${res} (turns auto off)`}
                        >
                            r{res} · {fmtPx(px)}px
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

/** Drawer-friendly numeric slider with inline value, min/max, and a
 *  reset-to-default chip when the user has overridden the default. */
function NumberSlider({
    label, value, onChange, min, max, step, defaultValue, reset, unit,
}: {
    label: string
    value: number
    onChange: (n: number) => void
    min: number
    max: number
    step: number
    defaultValue: number
    reset: () => void
    unit?: string
}) {
    const overridden = value !== defaultValue
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.78em" }}>
                {label}: <b>{Number.isInteger(step) ? Math.round(value) : value}{unit ?? ""}</b>
                {overridden && (
                    <button
                        type="button" onClick={reset} title={`Reset to ${defaultValue}`}
                        style={{
                            marginLeft: 4, padding: "0 4px", fontSize: "0.85em",
                            background: "transparent", color: "inherit", opacity: 0.6,
                            border: "1px solid currentColor", borderRadius: 3, cursor: "pointer",
                        }}
                    >↺</button>
                )}
            </span>
            <input
                type="range" min={min} max={max} step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                style={{ width: 100 }}
            />
        </label>
    )
}

/** Collapsible "Debug" section in the controls drawer. Click the header to
 *  expand. Open/closed state persists per session via `useSsBool` in the
 *  caller. */
function DebugSection({
    open, onToggle, theme, fg, children,
}: {
    open: boolean
    onToggle: () => void
    theme: "light" | "dark"
    fg: string
    children: ReactNode
}) {
    const dim = theme === "dark" ? "#888" : "#666"
    return (
        <div style={{ marginTop: 6, paddingTop: 4, borderTop: `1px solid ${theme === "dark" ? "#333" : "#ddd"}` }}>
            <button
                type="button" onClick={onToggle}
                title={open ? "Collapse debug" : "Expand debug"}
                aria-expanded={open}
                style={{
                    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: "transparent", color: fg, border: "none", padding: "2px 0",
                    cursor: "pointer", font: "inherit", fontSize: "0.82em",
                }}
            >
                <span style={{ color: dim }}>debug</span>
                <span style={{ color: dim }}>{open ? "▾" : "▸"}</span>
            </button>
            {open && <div style={{ marginTop: 4 }}>{children}</div>}
        </div>
    )
}

