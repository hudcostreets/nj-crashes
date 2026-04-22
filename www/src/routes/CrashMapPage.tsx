/** General crash-map route, parquet-backed via `useCrashData`.
 *
 *  URL: /map  OR  /map/:county  OR  /map/:county/:muni
 *
 *  The parquet backend (see `specs/map-data-backend.md`) ships per-year,
 *  per-county shards and pre-aggregated hex parquets. This component loads
 *  only the slices needed for the current filter (date range, county/muni,
 *  zoom).
 */
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useTheme } from "@/src/contexts/ThemeContext"
import { lazy, Suspense } from "react"
import type { CrashFilter } from "@/src/map/useCrashData"
import { useCrashData } from "@/src/map/useCrashData"
import type { MapMode } from "@/src/map/CrashMap"
import type { Crash } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import type { FeatureCollection } from "geojson"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

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

export default function CrashMapPage() {
    const params = useParams()
    const cc = countyFromParam(params.county)
    const { actualTheme } = useTheme()
    const [mode, setMode] = useState<MapMode>("hexbin")
    const [yearRange, setYearRange] = useState<[number, number]>([2019, 2023])
    // Severities to include. 'f' and 'i' by default (what's in the exported
    // parquet shards at the time of writing — `p` stretch).
    const [severities, setSeverities] = useState<Set<"f" | "i" | "p">>(() => new Set(["f", "i"]))

    // Use hex aggregates at low zoom (statewide / multi-county). Zoom-aware
    // switching happens in CrashMap itself; the client loader uses 'detail'
    // for now, and the hex mode client-side bins on the already-loaded data.
    // TODO: wire statewide low-zoom to `scale: 'r8'` and dispatch based on
    // zoom. For now the 234K-point statewide scatter works at ~30fps on desktop.
    const filter: CrashFilter = useMemo(() => ({
        yearRange,
        ccs: cc ? [cc] : undefined,
        severities,
        scale: "detail",
    }), [yearRange, cc, severities])

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
        if (cc !== undefined && m?.county_bboxes?.[cc]) return m.county_bboxes[cc]
        return STATE_BBOX
    }, [cc, result.manifest])

    const title = cc === undefined
        ? "NJ Crash Map"
        : `${titleCase(params.county ?? "")} County Crash Map`

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
                    <CrashMap
                        crashes={result.data as Crash[]}
                        outline={outline ?? undefined}
                        initialBounds={initialBounds}
                        mode={mode}
                        theme={actualTheme}
                    />
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
    total, manifest, yearRange, cc, theme,
}: {
    total: number
    manifest: MapManifest | undefined
    yearRange: [number, number]
    cc?: number
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    return (
        <div style={{
            position: "absolute", bottom: "1em", left: "1em", background: bg, color: fg,
            padding: "0.5em 0.9em", borderRadius: 4, zIndex: 1000, fontSize: "0.85em", maxWidth: 320,
        }}>
            <div><b>{total.toLocaleString()}</b> crashes plotted ({yearRange[0]}–{yearRange[1]}{cc ? `, cc=${cc}` : ", statewide"})</div>
            {manifest && (
                <div style={{ fontSize: "0.85em", opacity: 0.75 }}>
                    geocode: {manifest.by_geocode_src.interpolated?.toLocaleString() ?? 0} interpolated,{" "}
                    {manifest.by_geocode_src.original?.toLocaleString() ?? 0} original
                </div>
            )}
        </div>
    )
}
