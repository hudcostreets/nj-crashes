/** Embeddable crash-map panel for Home.tsx geo-filtered pages.
 *
 *  Scope (cc, mc) comes from the caller. Otherwise mirrors the
 *  standalone `/map` route: year-range slider, severity toggle, mode
 *  toggle (hexbin default), outline overlay, fit-bounds on scope.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { useCrashData } from "@/src/map/useCrashData"
import type { CrashFilter } from "@/src/map/useCrashData"
import type { Crash, MapMode, ViewState } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import { useTheme } from "@/src/contexts/ThemeContext"
import type { FeatureCollection } from "geojson"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

const DRAWER_SS_KEY = "hccs.crashmap.embed.drawerOpen"

/** Per-county initial view overrides (mobile + desktop pairs, lerped by width).
 *  Keys are numeric county codes (cc). Captured from user-tuned `?llz=` URLs
 *  and used instead of `initialBounds` auto-fit for these scopes. Add entries
 *  by loading the map, dragging to the desired framing at mobile and desktop
 *  viewport widths, and copying the `?llz=` values into this table. */
const LLZ_OVERRIDES: Record<number, { mobile: ViewState; desktop: ViewState }> = {
    9: {  // Hudson
        mobile:  { latitude: 40.7135, longitude: -74.0956, zoom: 10.63, pitch: 45, bearing: 0 },
        desktop: { latitude: 40.7119, longitude: -74.0936, zoom: 10.84, pitch: 45, bearing: 0 },
    },
    13: {  // Monmouth
        mobile:  { latitude: 40.1719, longitude: -74.3069, zoom: 8.65, pitch: 45, bearing: 0 },
        desktop: { latitude: 40.2188, longitude: -74.3049, zoom: 9.61, pitch: 45, bearing: 0 },
    },
}

/** `llz` URL param: "lat_lon_zoom_pitch_bearing" (pitch/bearing optional).
 *  Overrides the auto-fit. Intended for tuning default embed views. */
const llzParam: Param<ViewState | null> = {
    encode: (v) => v
        ? [v.latitude.toFixed(4), v.longitude.toFixed(4), v.zoom.toFixed(2), Math.round(v.pitch), Math.round(v.bearing)].join("_")
        : "",
    decode: (s) => {
        if (!s) return null
        const parts = s.split(/[_\s]/).map(Number)
        if (parts.length < 3 || parts.some(isNaN)) return null
        return {
            latitude: parts[0],
            longitude: parts[1],
            zoom: parts[2],
            pitch: parts[3] ?? 45,
            bearing: parts[4] ?? 0,
        }
    },
}

export type Props = {
    /** County code (1-21) or null for statewide. */
    cc: number | null
    /** Municipality code (within cc) or null. */
    mc: number | null
    /** Embed height. Default 500px. */
    height?: number | string
}

export function CrashMapSection({ cc, mc, height = 500 }: Props) {
    const { actualTheme } = useTheme()
    const [mode, setMode] = useState<MapMode>("hexbin")
    const [yearRange, setYearRange] = useState<[number, number]>([2019, 2023])
    const [severities, setSeverities] = useState<Set<"f" | "i" | "p">>(() => new Set(["f", "i"]))
    const [hexPxTarget, setHexPxTarget] = useState(1.2)
    const [elevationPerCount, setElevationPerCount] = useState(60)
    const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
        try { return sessionStorage.getItem(DRAWER_SS_KEY) === "1" } catch { return false }
    })
    useEffect(() => {
        try { sessionStorage.setItem(DRAWER_SS_KEY, drawerOpen ? "1" : "0") } catch {}
    }, [drawerOpen])
    const [llz, setLlz] = useUrlState("llz", llzParam)

    const scale: CrashFilter["scale"] = (cc === null && mode === "hexbin") ? "r8" : "detail"

    const filter: CrashFilter = useMemo(() => ({
        yearRange,
        ccs: cc !== null ? [cc] : undefined,
        mc: mc ?? undefined,
        severities,
        scale,
    }), [yearRange, cc, mc, severities, scale])

    const result = useCrashData(filter)
    const [outline, setOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        const url = cc === null
            ? "/njdot/map/counties.geojson"
            : `/njdot/map/counties/${String(cc).padStart(2, "0")}.geojson`
        fetch(url).then(r => r.ok ? r.json() : null).then(setOutline).catch(() => setOutline(null))
    }, [cc])

    const initialBounds: [number, number, number, number] = useMemo(() => {
        const m = result.manifest
        if (cc !== null && mc !== null) {
            const mb = m?.muni_bboxes?.[`${cc}-${mc}`]
            if (mb) return mb
        }
        if (cc !== null && m?.county_bboxes?.[cc]) return m.county_bboxes[cc]
        return STATE_BBOX
    }, [cc, mc, result.manifest])

    // Per-county override applies only when no muni is selected (muni view
    // still auto-fits from the muni bbox, which is typically small enough).
    const initialView = cc !== null && mc === null ? (LLZ_OVERRIDES[cc] ?? null) : null

    const bg = actualTheme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = actualTheme === "dark" ? "#e0e0e0" : "#333"
    const activeBg = actualTheme === "dark" ? "#6db3f2" : "#0066cc"

    const [y0min, y1max] = result.manifest?.year_range ?? [2001, 2023]

    return (
        <div style={{ position: "relative", height, width: "100%", borderRadius: 4, overflow: "hidden" }}>
            {result.status === "error" && (
                <div style={{ padding: "1em", color: "red" }}>Error: {result.error}</div>
            )}
            {result.status === "loading" && (
                <div style={{ padding: "1em", color: fg }}>Loading map data…</div>
            )}
            {result.status === "ready" && (
                <Suspense fallback={<div style={{ padding: "1em", color: fg }}>Loading map…</div>}>
                    {scale === "detail" ? (
                        <CrashMap
                            crashes={result.data as Crash[]}
                            outline={outline ?? undefined}
                            initialBounds={initialBounds}
                            initialView={initialView}
                            viewState={llz ?? undefined}
                            onViewStateChange={setLlz}
                            mode={mode}
                            theme={actualTheme}
                            height={height}
                            showInternalControls={false}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            elevationPerCount={elevationPerCount}
                            onElevationPerCountChange={setElevationPerCount}
                        />
                    ) : (
                        <CrashMap
                            prebinnedHexes={result.data as StackedHex[]}
                            outline={outline ?? undefined}
                            initialBounds={initialBounds}
                            initialView={initialView}
                            viewState={llz ?? undefined}
                            onViewStateChange={setLlz}
                            mode="hexbin"
                            theme={actualTheme}
                            height={height}
                            showInternalControls={false}
                            hexPxTarget={hexPxTarget}
                            onHexPxTargetChange={setHexPxTarget}
                            elevationPerCount={elevationPerCount}
                            onElevationPerCountChange={setElevationPerCount}
                        />
                    )}
                </Suspense>
            )}
            {!drawerOpen && (
                <button
                    onClick={() => setDrawerOpen(true)}
                    title="Show controls"
                    style={{
                        position: "absolute", top: 8, right: 8, background: bg, color: fg,
                        padding: "0.25em 0.5em", borderRadius: 4, zIndex: 1000,
                        border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                        cursor: "pointer", fontSize: "1em", lineHeight: 1,
                    }}
                >⚙</button>
            )}
            {drawerOpen && (
            <div style={{
                position: "absolute", top: 8, right: 8, background: bg, color: fg,
                padding: "0.4em 0.6em", borderRadius: 4, zIndex: 1000, fontSize: "0.82em",
                display: "flex", flexDirection: "column", gap: 6, minWidth: 210, maxWidth: 260,
            }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -4 }}>
                    <button
                        onClick={() => setDrawerOpen(false)}
                        title="Hide controls"
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
                <div>
                    <div style={{ fontSize: "0.85em" }}>
                        Years: <b>{yearRange[0]}–{yearRange[1]}</b>
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
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
                <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.85em", flexWrap: "wrap" }}>
                    <span>Severity:</span>
                    {(["f", "i", "p"] as const).map(s => {
                        const checked = severities.has(s)
                        const label = s === "f" ? "Fatal" : s === "i" ? "Injury" : "PDO"
                        const disabled = s === "p" && scale !== "r8"
                        return (
                            <label key={s}
                                title={disabled ? "PDO only available in statewide + Hexbin mode" : undefined}
                                style={{
                                    display: "inline-flex", alignItems: "center", gap: 3,
                                    cursor: disabled ? "not-allowed" : "pointer",
                                    opacity: disabled ? 0.5 : 1,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked && !disabled}
                                    disabled={disabled}
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
                {mode === "hexbin" && (
                    <>
                        {(() => {
                            const sliderValue = Math.round(100 * (1 - Math.log2(hexPxTarget) / Math.log2(60)))
                            return (
                                <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                                    <span style={{ fontSize: "0.78em" }}>Hex density: <b>{sliderValue}</b></span>
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
                            )
                        })()}
                        <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                            <span style={{ fontSize: "0.78em" }}>Bar height: <b>{elevationPerCount}×</b></span>
                            <input
                                type="range" min={3} max={150} step={1}
                                value={elevationPerCount}
                                onChange={e => setElevationPerCount(Number(e.target.value))}
                                style={{ width: 100 }}
                            />
                        </label>
                    </>
                )}
            </div>
            )}
        </div>
    )
}
