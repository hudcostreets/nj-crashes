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
import { useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useTheme } from "@/src/contexts/ThemeContext"
import { lazy, Suspense } from "react"
import type { CrashFilter } from "@/src/map/useCrashData"
import { useCrashData } from "@/src/map/useCrashData"
import type { MapMode, ViewState } from "@/src/map/CrashMap"
import type { Crash } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import type { FeatureCollection } from "geojson"

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
        if (!s) return 1.8
        const n = Number(s)
        return Number.isFinite(n) && n > 0 ? n : 1.8
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
    const [cc2mc2mn, setCc2mc2mn] = useState<Cc2Mc2Mn | null>(null)
    useEffect(() => {
        fetch("/njdot/cc2mc2mn.json").then(r => r.json()).then(setCc2mc2mn).catch(() => {})
    }, [])
    const cc = countyFromParam(params.county)
    const mc = muniFromParam(cc, params.muni, cc2mc2mn)
    const { actualTheme } = useTheme()

    // URL-synced state
    const [mode, setMode] = useUrlState("m", modeParam)
    const [yearRange, setYearRange] = useUrlState("y", yearRangeParam)
    const [severities, setSeverities] = useUrlState("s", severitiesParam)
    const [urlView, setUrlView] = useUrlState("v", viewParam)
    const [hexPxTarget, setHexPxTarget] = useUrlState("h", hexPxParam)

    // For statewide views in hexbin mode, fetch pre-aggregated h3-r8 cells
    // from the server (~2 MB vs 30 MB for 234K raw rows) and skip client-side
    // binning. Everything else uses individual crash rows ("detail").
    const scale: CrashFilter["scale"] =
        (cc === undefined && mode === "hexbin") ? "r8" : "detail"

    const filter: CrashFilter = useMemo(() => ({
        yearRange,
        ccs: cc ? [cc] : undefined,
        mc,
        severities,
        scale,
    }), [yearRange, cc, mc, severities, scale])

    const result = useCrashData(filter)
    const [outline, setOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        const url = cc === undefined
            ? "/njdot/map/counties.geojson"
            : `/njdot/map/counties/${String(cc).padStart(2, "0")}.geojson`
        fetch(url).then(r => r.ok ? r.json() : null).then(setOutline).catch(() => setOutline(null))
    }, [cc])

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

    // Internal viewState mirrors URL but updates at 60fps; URL writes
    // debounced at 500ms to avoid spamming history.
    const [viewState, setViewState] = useState<ViewState>(() => (
        urlView ?? fitBoundsToView(initialBounds, mode === "hexbin" ? 45 : 0)
    ))
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
            {result.status === "ready" && (
                <Suspense fallback={<div style={{ padding: "1em" }}>Loading map…</div>}>
                    {scale === "detail" ? (
                        <CrashMap
                            crashes={result.data as Crash[]}
                            outline={outline ?? undefined}
                            initialBounds={initialBounds}
                            viewState={viewState}
                            onViewStateChange={setViewState}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            mode={mode}
                            theme={actualTheme}
                        />
                    ) : (
                        <CrashMap
                            prebinnedHexes={result.data as StackedHex[]}
                            outline={outline ?? undefined}
                            initialBounds={initialBounds}
                            viewState={viewState}
                            onViewStateChange={setViewState}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            mode="hexbin"
                            theme={actualTheme}
                        />
                    )}
                </Suspense>
            )}
            <ControlBar
                mode={mode} setMode={setMode}
                yearRange={yearRange} setYearRange={setYearRange}
                severities={severities} setSeverities={setSeverities}
                manifest={result.manifest}
                theme={actualTheme}
            />
            {result.status === "ready" && (
                <StatsBox
                    total={result.data.length}
                    manifest={result.manifest}
                    yearRange={yearRange}
                    cc={cc}
                    mc={mc}
                    scopeLabel={
                        mc !== undefined ? `${muniName}, ${countyName}` :
                        cc !== undefined ? `${countyName} County` :
                        "statewide"
                    }
                    theme={actualTheme}
                />
            )}
        </div>
    )
}

function titleCase(s: string): string {
    return s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function ControlBar({
    mode, setMode, yearRange, setYearRange, severities, setSeverities, manifest, theme,
}: {
    mode: MapMode
    setMode: (m: MapMode) => void
    yearRange: [number, number]
    setYearRange: (r: [number, number]) => void
    severities: Set<"f" | "i" | "p">
    setSeverities: (s: Set<"f" | "i" | "p">) => void
    manifest: MapManifest | undefined
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const activeBg = theme === "dark" ? "#6db3f2" : "#0066cc"
    const [y0min, y1max] = manifest?.year_range ?? [2001, 2023]
    return (
        <div style={{
            position: "absolute", top: "1em", right: "1em", background: bg, color: fg,
            padding: "0.5em 0.7em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em",
            display: "flex", flexDirection: "column", gap: 8, minWidth: 220,
        }}>
            <div style={{ display: "flex", gap: 4 }}>
                {(["scatter", "heatmap", "hexbin"] as MapMode[]).map(m => (
                    <button
                        key={m}
                        onClick={() => setMode(m)}
                        style={{
                            padding: "0.3em 0.7em",
                            cursor: "pointer",
                            background: mode === m ? activeBg : "transparent",
                            color: mode === m ? "#fff" : fg,
                            border: `1px solid ${mode === m ? activeBg : fg}`,
                            borderRadius: 3,
                            fontSize: "0.9em",
                            flex: 1,
                        }}
                    >{m === "scatter" ? "Points" : m === "heatmap" ? "Heatmap" : "Hexbin"}</button>
                ))}
            </div>
            <div>
                <div style={{ fontSize: "0.8em", marginBottom: 4 }}>
                    Years: <b>{yearRange[0]}–{yearRange[1]}</b>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                        type="range" min={y0min} max={y1max} step={1}
                        value={yearRange[0]}
                        onChange={e => setYearRange([Math.min(Number(e.target.value), yearRange[1]), yearRange[1]])}
                        style={{ width: 80 }}
                    />
                    <input
                        type="range" min={y0min} max={y1max} step={1}
                        value={yearRange[1]}
                        onChange={e => setYearRange([yearRange[0], Math.max(Number(e.target.value), yearRange[0])])}
                        style={{ width: 80 }}
                    />
                </div>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center", fontSize: "0.85em" }}>
                <span>Severity:</span>
                {(["f", "i"] as const).map(s => {
                    const checked = severities.has(s)
                    const label = s === "f" ? "Fatal" : s === "i" ? "Injury" : "PDO"
                    return (
                        <label key={s} style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
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
        </div>
    )
}

type MapManifest = import("@/src/map/useCrashData").MapManifest

function StatsBox({
    total, manifest, yearRange, cc, mc, scopeLabel, theme,
}: {
    total: number
    manifest: MapManifest | undefined
    yearRange: [number, number]
    cc?: number
    mc?: number
    scopeLabel: string
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    return (
        <div style={{
            position: "absolute", bottom: "1em", left: "1em", background: bg, color: fg,
            padding: "0.5em 0.9em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em", maxWidth: 320,
        }}>
            <div><b>{total.toLocaleString()}</b> crashes plotted ({yearRange[0]}–{yearRange[1]}, {scopeLabel})</div>
            {manifest && (
                <div style={{ fontSize: "0.85em", opacity: 0.75 }}>
                    geocode: {manifest.by_geocode_src.interpolated?.toLocaleString() ?? 0} interpolated,{" "}
                    {manifest.by_geocode_src.original?.toLocaleString() ?? 0} original
                </div>
            )}
        </div>
    )
}
