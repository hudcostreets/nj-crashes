/** General crash-map route, parquet-backed via `useCrashData`.
 *
 *  URL: /map  OR  /map/c/:county  OR  /map/c/:county/:muni
 *
 *  Query params (use-prms):
 *    v  – viewState: "lat lon zoom pitch bearing" (packed, 1-decimal zoom)
 *    m  – mode: s (scatter) | h (heatmap) | x (hexbin; default)
 *    y  – year range: "Y0-Y1" (default "2019-2023")
 *    s  – severities: concat of {f,i,p}, default "fi"
 *
 *  The parquet backend (see `specs/map-data-backend.md`) ships per-year,
 *  per-county shards and pre-aggregated hex parquets. This component loads
 *  only the slices needed for the current filter (date range, county/muni,
 *  zoom).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useTheme } from "@/src/contexts/ThemeContext"
import { lazy, Suspense } from "react"
import type { CrashFilter } from "@/src/map/useCrashData"
import { useCrashData } from "@/src/map/useCrashData"
import { MAP_BASE_URL } from "@/src/map/config"
import { bboxFromViewport } from "@/src/map/v2"
import type { MapMode, ViewState } from "@/src/map/CrashMap"
import type { Crash } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import type { FeatureCollection } from "geojson"
import { normalize } from "@/src/county"
import { useToolboxOpen } from "@/src/map/useToolboxOpen"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

/** Compute a ViewState that fits the given [w,s,e,n] bounds into the
 *  current window with some padding. Uses Web Mercator meters/pixel math.
 *  Matches (approximately) `maplibregl.Map.cameraForBounds` behaviour but
 *  runs without a Map instance. */
function fitBoundsToView(
    bounds: [number, number, number, number],
    pitch = 0,
): ViewState {
    const [w, s, e, n] = bounds
    const lat = (s + n) / 2
    const lon = (w + e) / 2
    const padPx = 40
    const containerW = Math.max(200, window.innerWidth - padPx * 2)
    const containerH = Math.max(200, window.innerHeight - padPx * 2)
    const COS = Math.cos(lat * Math.PI / 180)
    const metersPerDegLon = 111_320 * COS
    const metersPerDegLat = 110_574
    const lateralM = Math.max(1, (e - w) * metersPerDegLon)
    const verticalM = Math.max(1, (n - s) * metersPerDegLat)
    const mppNeeded = Math.max(lateralM / containerW, verticalM / containerH)
    // Zoom where m/px at this latitude ≈ mppNeeded
    // m/px at zoom z = 156543.03 * cos(lat) / 2^z  =>  z = log2(156543.03 * cos(lat) / m/px)
    const zoom = Math.log2(156543.03 * COS / mppNeeded)
    return { latitude: lat, longitude: lon, zoom: Math.max(7, Math.min(18, zoom)), pitch, bearing: 0 }
}

// --- URL param encoders ---
const MODE_CODES: Record<MapMode, string> = { scatter: "s", heatmap: "h", hexbin: "x" }
const MODE_FROM_CODE: Record<string, MapMode> = { s: "scatter", h: "heatmap", x: "hexbin" }

const modeParam: Param<MapMode> = {
    encode: (m) => MODE_CODES[m],
    decode: (s) => s ? (MODE_FROM_CODE[s] ?? "hexbin") : "hexbin",
}

function encodeView(v: ViewState): string {
    const parts = [
        v.latitude.toFixed(4),
        v.longitude.toFixed(4),
        v.zoom.toFixed(1),
        String(Math.round(v.pitch)),
        String(Math.round(v.bearing)),
    ]
    // Space-separated, but put "+" between parts so urlencoding keeps them
    // compact and no extra % escapes. Readers tolerate any whitespace.
    return parts.join("_")
}
function decodeView(s: string | undefined): ViewState | null {
    if (!s) return null
    const parts = s.split(/[_\s]/).map(Number)
    if (parts.length < 3 || parts.some(isNaN)) return null
    return {
        latitude: parts[0],
        longitude: parts[1],
        zoom: parts[2],
        pitch: parts[3] ?? 0,
        bearing: parts[4] ?? 0,
    }
}
const viewParam: Param<ViewState | null> = {
    encode: (v) => v ? encodeView(v) : "",
    decode: (s) => decodeView(s),
}

const yearRangeParam: Param<[number, number]> = {
    encode: ([a, b]) => `${a}-${b}`,
    decode: (s) => {
        if (!s) return [2019, 2023]
        const m = s.match(/^(\d{4})-(\d{4})$/)
        if (!m) return [2019, 2023]
        const a = +m[1], b = +m[2]
        return a <= b ? [a, b] : [b, a]
    },
}

const hexPxParam: Param<number> = {
    encode: (n) => n.toString(),
    decode: (s) => {
        if (!s) return 1.2
        const n = Number(s)
        return Number.isFinite(n) && n > 0 ? n : 1.2
    },
}

const severitiesParam: Param<Set<"f" | "i" | "p">> = {
    encode: (s) => [...s].sort().join(""),
    decode: (str) => {
        if (!str) return new Set(["f", "i"])
        const out = new Set<"f" | "i" | "p">()
        for (const c of str) {
            if (c === "f" || c === "i" || c === "p") out.add(c)
        }
        return out.size ? out : new Set(["f", "i"])
    },
}

// Local county-name → cc map (subset; full table in nj_crashes data files)
const COUNTY_NAMES: Record<string, number> = {
    atlantic: 1, bergen: 2, burlington: 3, camden: 4, capemay: 5, "cape-may": 5,
    cumberland: 6, essex: 7, gloucester: 8, hudson: 9, hunterdon: 10, mercer: 11,
    middlesex: 12, monmouth: 13, morris: 14, ocean: 15, passaic: 16, salem: 17,
    somerset: 18, sussex: 19, union: 20, warren: 21,
}

function countyFromParam(param?: string): number | undefined {
    if (!param) return undefined
    const k = param.toLowerCase().replace(/\s+/g, "-")
    return COUNTY_NAMES[k]
}

type Cc2Mc2Mn = Record<string, { cn: string; mc2mn: Record<string, string> }>

function muniFromParam(cc: number | undefined, muni: string | undefined, lookup: Cc2Mc2Mn | null): number | undefined {
    if (!cc || !muni || !lookup) return undefined
    const mc2mn = lookup[String(cc)]?.mc2mn
    if (!mc2mn) return undefined
    const norm = muni.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim()
    for (const [mc, name] of Object.entries(mc2mn)) {
        if (name.toLowerCase() === norm) return Number(mc)
    }
    return undefined
}

export default function CrashMapPage() {
    const params = useParams()
    const navigate = useNavigate()
    const [cc2mc2mn, setCc2mc2mn] = useState<Cc2Mc2Mn | null>(null)
    useEffect(() => {
        fetch("/njdot/cc2mc2mn.json").then(r => r.json()).then(setCc2mc2mn).catch(() => {})
    }, [])
    const cc = countyFromParam(params.county)
    const mc = muniFromParam(cc, params.muni, cc2mc2mn)
    const { actualTheme } = useTheme()
    const [elevationPerCount, setElevationPerCount] = useState(60)
    const [drawerOpen, setDrawerOpen] = useToolboxOpen(true)

    const onOutlineClick = useCallback((feature: any) => {
        const name: string | undefined = feature?.properties?.name
        if (!name) return
        // Statewide → drill to county. (Muni-level drill requires sharded
        // muni-boundary geojson, not yet wired.)
        if (cc === undefined) navigate(`/map/${normalize(name)}`)
    }, [cc, navigate])

    // URL-synced state
    const [mode, setMode] = useUrlState("m", modeParam)
    const [yearRange, setYearRange] = useUrlState("y", yearRangeParam)
    const [severities, setSeverities] = useUrlState("s", severitiesParam)
    const [urlView, setUrlView] = useUrlState("v", viewParam)
    const [hexPxTarget, setHexPxTarget] = useUrlState("h", hexPxParam)

    // viewState is built before the filter so the v2 backend (when active)
    // can include the viewport bbox in its shard-selection plan. Initial
    // fit uses STATE_BBOX as a placeholder; once `result.manifest` loads,
    // the per-county/muni bbox is applied via the snap effect below.
    const [viewState, setViewState] = useState<ViewState>(() => (
        urlView ?? fitBoundsToView(STATE_BBOX, mode === "hexbin" ? 45 : 0)
    ))

    // PDO data is always available in v2 (hex prebins + point shards
    // both carry it), so the PDO checkbox is unconditionally enabled now.
    const filter: CrashFilter = useMemo(() => {
        // Approximate the visible bbox from viewState. Width/height come
        // from the window — the map fills the viewport on this route.
        const w = typeof window !== "undefined" ? window.innerWidth : 1280
        const h = typeof window !== "undefined" ? window.innerHeight : 900
        return {
            yearRange,
            ccs: cc ? [cc] : undefined,
            mc,
            severities,
            viewport: bboxFromViewport(viewState.latitude, viewState.longitude, viewState.zoom, w, h, viewState.pitch),
            viewportLat: viewState.latitude,
            zoom: viewState.zoom,
            hexPxTarget,
        }
    }, [yearRange, cc, mc, severities, viewState, hexPxTarget])

    const result = useCrashData(filter)
    const [outline, setOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        const url = cc === undefined
            ? `${MAP_BASE_URL}/counties.geojson`
            : `${MAP_BASE_URL}/counties/${String(cc).padStart(2, "0")}.geojson`
        fetch(url).then(r => r.ok ? r.json() : null).then(setOutline).catch(() => setOutline(null))
    }, [cc])
    const [muniOutline, setMuniOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        if (cc === undefined || mc === undefined) { setMuniOutline(null); return }
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

    // Prefer bbox from manifest (exact, computed from data points) once loaded.
    const initialBounds: [number, number, number, number] = useMemo(() => {
        const m = result.manifest
        if (cc !== undefined && mc !== undefined) {
            const mb = m?.muni_bboxes?.[`${cc}-${mc}`]
            if (mb) return mb
        }
        if (cc !== undefined && m?.county_bboxes?.[cc]) return m.county_bboxes[cc]
        return STATE_BBOX
    }, [cc, mc, result.manifest])

    // viewState was declared above the filter (see comment there). Internal
    // state mirrors URL but updates at 60fps; URL writes are debounced at
    // 500ms to avoid spamming history.
    // If the manifest arrives after mount AND we don't have a URL view,
    // snap to a proper fit of the new bounds (fixes e.g. /map/bergen where
    // initial default `initialBounds` is the statewide box but we got the
    // Bergen-specific one after manifest load).
    const fitKeyRef = useRef<string>(JSON.stringify(initialBounds))
    useEffect(() => {
        if (urlView) return
        const key = JSON.stringify(initialBounds)
        if (key === fitKeyRef.current) return
        fitKeyRef.current = key
        setViewState(fitBoundsToView(initialBounds, mode === "hexbin" ? 45 : 0))
    }, [initialBounds, urlView, mode])
    const urlViewRef = useRef(urlView)
    urlViewRef.current = urlView
    const setUrlViewRef = useRef(setUrlView)
    setUrlViewRef.current = setUrlView
    // Apply URL → internal when URL changes externally (e.g. back/forward).
    useEffect(() => {
        if (!urlView) return
        setViewState(v => (
            v.latitude === urlView.latitude
            && v.longitude === urlView.longitude
            && v.zoom === urlView.zoom
            && v.pitch === urlView.pitch
            && v.bearing === urlView.bearing
        ) ? v : urlView)
    }, [urlView])
    // Debounce URL writes when internal view changes.
    useEffect(() => {
        const t = setTimeout(() => setUrlViewRef.current(viewState), 400)
        return () => clearTimeout(t)
    }, [viewState])

    const muniName = params.muni ? titleCase(params.muni) : undefined
    const countyName = params.county ? titleCase(params.county) : undefined
    const title = cc === undefined
        ? "NJ Crash Map"
        : mc !== undefined
            ? `${muniName}, ${countyName} County Crash Map`
            : `${countyName} County Crash Map`

    return (
        <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
            <Head title={title} description="Interactive crash map" url={url} />
            {result.status === "error" && (
                <div style={{ padding: "1em", color: "red" }}>Error: {result.error}</div>
            )}
            {result.status === "loading" && (
                <div style={{ padding: "1em" }}>Loading map data…</div>
            )}
            {result.status === "ready" && result.refetching && (
                <div style={{
                    position: "absolute", top: 8, right: 8, zIndex: 5,
                    width: 24, height: 24, borderRadius: "50%", padding: 4,
                    background: actualTheme === "dark" ? "rgba(30,30,30,0.6)" : "rgba(255,255,255,0.7)",
                    pointerEvents: "none",
                }}>
                    <style>{`@keyframes hccs-spin { to { transform: rotate(360deg) } }`}</style>
                    <div style={{
                        width: "100%", height: "100%", borderRadius: "50%",
                        border: `2px solid ${actualTheme === "dark" ? "#aaa" : "#555"}`,
                        borderTopColor: "transparent",
                        animation: "hccs-spin 0.8s linear infinite",
                    }} />
                </div>
            )}
            {result.status === "ready" && (
                <Suspense fallback={<div style={{ padding: "1em" }}>Loading map…</div>}>
                    {result.dataKind === "points" ? (
                        <CrashMap
                            crashes={result.data as Crash[]}
                            outline={outline ?? undefined}
                            muniOutline={muniOutline ?? undefined}
                            initialBounds={initialBounds}
                            viewState={viewState}
                            onViewStateChange={setViewState}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            elevationPerCount={elevationPerCount}
                            onElevationPerCountChange={setElevationPerCount}
                            yearSpan={yearRange[1] - yearRange[0] + 1}
                            onOutlineClick={cc === undefined ? onOutlineClick : undefined}
                            showInternalControls={false}
                            mode={mode}
                            theme={actualTheme}
                        />
                    ) : (
                        <CrashMap
                            prebinnedHexes={result.data as StackedHex[]}
                            outline={outline ?? undefined}
                            muniOutline={muniOutline ?? undefined}
                            initialBounds={initialBounds}
                            viewState={viewState}
                            onViewStateChange={setViewState}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            elevationPerCount={elevationPerCount}
                            onElevationPerCountChange={setElevationPerCount}
                            yearSpan={yearRange[1] - yearRange[0] + 1}
                            onOutlineClick={cc === undefined ? onOutlineClick : undefined}
                            showInternalControls={false}
                            mode="hexbin"
                            theme={actualTheme}
                        />
                    )}
                </Suspense>
            )}
            <ControlDrawer
                open={drawerOpen} setOpen={setDrawerOpen}
                scopeLabel={
                    mc !== undefined ? `${muniName}, ${countyName}` :
                    cc !== undefined ? `${countyName} County` :
                    "NJ statewide"
                }
                detailsHref={
                    params.muni ? `/c/${params.county}/${params.muni}` :
                    params.county ? `/c/${params.county}` :
                    "/"
                }
                mode={mode} setMode={setMode}
                yearRange={yearRange} setYearRange={setYearRange}
                severities={severities} setSeverities={setSeverities}
                hexPxTarget={hexPxTarget} setHexPxTarget={setHexPxTarget}
                elevationPerCount={elevationPerCount} setElevationPerCount={setElevationPerCount}
                pitch={viewState.pitch}
                setPitch={p => setViewState(v => ({ ...v, pitch: p }))}
                total={result.status === "ready" ? result.data.length : undefined}
                manifest={result.manifest}
                theme={actualTheme}
            />
        </div>
    )
}

function titleCase(s: string): string {
    return s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

type MapManifest = import("@/src/map/useCrashData").MapManifest

const MAX_PITCH = 85

function ControlDrawer({
    open, setOpen, scopeLabel, detailsHref,
    mode, setMode,
    yearRange, setYearRange,
    severities, setSeverities,
    hexPxTarget, setHexPxTarget,
    elevationPerCount, setElevationPerCount,
    pitch, setPitch,
    total, manifest, theme,
}: {
    open: boolean
    setOpen: (b: boolean) => void
    scopeLabel: string
    detailsHref: string
    mode: MapMode
    setMode: (m: MapMode) => void
    yearRange: [number, number]
    setYearRange: (r: [number, number]) => void
    severities: Set<"f" | "i" | "p">
    setSeverities: (s: Set<"f" | "i" | "p">) => void
    hexPxTarget: number
    setHexPxTarget: (n: number) => void
    elevationPerCount: number
    setElevationPerCount: (n: number) => void
    pitch: number
    setPitch: (n: number) => void
    total?: number
    manifest: MapManifest | undefined
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const activeBg = theme === "dark" ? "#6db3f2" : "#0066cc"
    const subtleBorder = theme === "dark" ? "#444" : "#ccc"
    const [y0min, y1max] = manifest?.year_range ?? [2001, 2023]
    const sliderValue = Math.round(100 * (1 - Math.log2(hexPxTarget) / Math.log2(60)))

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                title="Show controls"
                style={{
                    position: "absolute", top: "1em", right: "1em", background: bg, color: fg,
                    padding: "0.35em 0.55em", borderRadius: 4, zIndex: 1000,
                    border: `1px solid ${subtleBorder}`, cursor: "pointer", fontSize: "1.1em", lineHeight: 1,
                }}
            >⚙</button>
        )
    }
    return (
        <div style={{
            position: "absolute", top: "1em", right: "1em", background: bg, color: fg,
            padding: "0.6em 0.8em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em",
            display: "flex", flexDirection: "column", gap: 10, minWidth: 240, maxWidth: 280,
        }}>
            {/* Scope header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{scopeLabel}</div>
                <button
                    onClick={() => setOpen(false)}
                    title="Hide controls"
                    style={{
                        background: "transparent", color: fg, border: "none",
                        cursor: "pointer", fontSize: "1em", padding: "0 0.3em",
                    }}
                >×</button>
            </div>
            <a href={detailsHref}
               style={{ color: activeBg, textDecoration: "none", fontSize: "0.85em" }}
            >View charts →</a>

            {/* Mode */}
            <div style={{ display: "flex", gap: 4 }}>
                {(["scatter", "heatmap", "hexbin"] as MapMode[]).map(m => (
                    <button
                        key={m}
                        onClick={() => setMode(m)}
                        style={{
                            padding: "0.3em 0.7em", cursor: "pointer",
                            background: mode === m ? activeBg : "transparent",
                            color: mode === m ? "#fff" : fg,
                            border: `1px solid ${mode === m ? activeBg : fg}`,
                            borderRadius: 3, fontSize: "0.9em", flex: 1,
                        }}
                    >{m === "scatter" ? "Points" : m === "heatmap" ? "Heatmap" : "Hexbin"}</button>
                ))}
            </div>

            {/* Year range */}
            <div>
                <div style={{ fontSize: "0.8em", marginBottom: 4 }}>
                    Years: <b>{yearRange[0]}–{yearRange[1]}</b>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                        type="range" min={y0min} max={y1max} step={1}
                        value={yearRange[0]}
                        onChange={e => setYearRange([Math.min(Number(e.target.value), yearRange[1]), yearRange[1]])}
                        style={{ flex: 1 }}
                    />
                    <input
                        type="range" min={y0min} max={y1max} step={1}
                        value={yearRange[1]}
                        onChange={e => setYearRange([yearRange[0], Math.max(Number(e.target.value), yearRange[0])])}
                        style={{ flex: 1 }}
                    />
                </div>
            </div>

            {/* Severity */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.85em", flexWrap: "wrap" }}>
                <span>Severity:</span>
                {(["f", "i", "p"] as const).map(s => {
                    const checked = severities.has(s)
                    const label = s === "f" ? "Fatal" : s === "i" ? "Injury" : "PDO"
                    return (
                        <label key={s}
                            style={{
                                display: "inline-flex", alignItems: "center", gap: 3,
                                cursor: "pointer",
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                    const next = new Set(severities)
                                    if (checked) next.delete(s); else next.add(s)
                                    setSeverities(next)
                                }}
                            />
                            {label}
                        </label>
                    )
                })}
            </div>

            {/* Hexbin-only controls */}
            {mode === "hexbin" && (
                <>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                        <span style={{ fontSize: "0.8em" }}>Hex density: <b>{sliderValue}</b> (~{hexPxTarget.toFixed(hexPxTarget < 5 ? 1 : 0)}px)</span>
                        <input
                            type="range" min={0} max={120} step={1}
                            value={sliderValue}
                            onChange={e => {
                                const v = Number(e.target.value)
                                const px = Math.pow(60, 1 - v / 100)
                                const rounded = px < 5 ? Math.round(px * 10) / 10 : Math.round(px)
                                setHexPxTarget(Math.max(0.5, rounded))
                            }}
                            style={{ width: 100 }}
                        />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                        <span style={{ fontSize: "0.8em" }}>Bar height: <b>{elevationPerCount}×</b></span>
                        <input
                            type="range" min={3} max={150} step={1}
                            value={elevationPerCount}
                            onChange={e => setElevationPerCount(Number(e.target.value))}
                            style={{ width: 100 }}
                        />
                    </label>
                </>
            )}

            {/* Pitch */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span style={{ fontSize: "0.8em" }}>Pitch: <b>{Math.round(pitch)}°</b></span>
                <input
                    type="range" min={0} max={MAX_PITCH} step={1}
                    value={pitch}
                    onChange={e => setPitch(Number(e.target.value))}
                    style={{ width: 100 }}
                />
            </label>

            {/* Stats */}
            {total !== undefined && (
                <div style={{ borderTop: `1px solid ${subtleBorder}`, paddingTop: 8, fontSize: "0.8em" }}>
                    <div><b>{total.toLocaleString()}</b> crashes plotted</div>
                    {manifest?.by_geocode_src && (
                        <div style={{ opacity: 0.75, marginTop: 2 }}>
                            geocode: {manifest.by_geocode_src?.interpolated?.toLocaleString() ?? 0} interpolated,{" "}
                            {manifest.by_geocode_src?.original?.toLocaleString() ?? 0} original
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
