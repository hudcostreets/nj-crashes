/** Embeddable crash-map panel for Home.tsx geo-filtered pages.
 *
 *  Scope (cc, mc) comes from the caller. Otherwise mirrors the
 *  standalone `/map` route: year-range slider, severity toggle, mode
 *  toggle (hexbin default), outline overlay, fit-bounds on scope.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { useCrashData } from "@/src/map/useCrashData"
import type { CrashFilter } from "@/src/map/useCrashData"
import type { Crash, MapMode, ViewState } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import { useTheme } from "@/src/contexts/ThemeContext"
import type { FeatureCollection } from "geojson"
import { FiMaximize2 } from "react-icons/fi"
import { useToolboxOpen } from "@/src/map/useToolboxOpen"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

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

/** `llz` URL param: "lat_lon_zoom_pitch_bearing" (pitch/bearing optional).
 *  Overrides the auto-fit. Intended for tuning default embed views. */
const llzParam: Param<ViewState | null> = {
    // `undefined` means "param absent" per use-prms 2-way binding contract
    // (default value ↔ param omitted). Avoid emitting `?llz=` or `?llz` for
    // the default / cleared state.
    encode: (v) => v
        ? [v.latitude.toFixed(4), v.longitude.toFixed(4), v.zoom.toFixed(2), Math.round(v.pitch), Math.round(v.bearing)].join("_")
        : undefined,
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
    /** Optional `href` for the full-screen icon (bottom-right). Omit to hide. */
    fullScreenHref?: string
    /** Geographic scope label rendered in the subtitle (e.g.
     *  "Jersey City, Hudson County"). When omitted, the subtitle is hidden. */
    scopeLabel?: string
}

export function CrashMapSection({ cc, mc, height = 500, fullScreenHref, scopeLabel }: Props) {
    const { actualTheme } = useTheme()
    const [mode, setMode] = useState<MapMode>("hexbin")
    const [yearRange, setYearRange] = useState<[number, number]>([2019, 2023])
    const [severities, setSeverities] = useState<Set<"f" | "i" | "p">>(() => new Set(["f", "i"]))
    const [hexPxTarget, setHexPxTarget] = useState(1.2)
    const [elevationPerCount, setElevationPerCount] = useState(60)
    const [drawerOpen, setDrawerOpen] = useToolboxOpen(false)
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
    // Muni outline: only when a muni is selected. File is ~30-130 KB/county;
    // filter client-side to the single feature matching our mc.
    const [muniOutline, setMuniOutline] = useState<FeatureCollection | null>(null)
    useEffect(() => {
        if (cc === null || mc === null) { setMuniOutline(null); return }
        const url = `/njdot/map/munis/${String(cc).padStart(2, "0")}.geojson`
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

    const emptySeverities = severities.size === 0

    const toggleSeverity = (s: "f" | "i" | "p") => {
        const next = new Set(severities)
        if (next.has(s)) next.delete(s); else next.add(s)
        setSeverities(next)
    }
    const severityPhrase = formatSeverityPhrase(severities)

    // Close drawer on canvas pointerdown. Hooks a native capture-phase
    // listener on the wrapper element — React's onPointerDownCapture
    // doesn't fire for real native events (mjolnir.js consumes them
    // before they reach React's root listener).
    const wrapRef = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
        if (!drawerOpen) return
        const el = wrapRef.current
        if (!el) return
        const handler = (e: PointerEvent) => {
            const target = e.target as Element | null
            if (target?.tagName === "CANVAS") setDrawerOpen(false)
        }
        el.addEventListener("pointerdown", handler, true)
        return () => el.removeEventListener("pointerdown", handler, true)
    }, [drawerOpen, setDrawerOpen])

    return (
        <>
            {(scopeLabel || true) && (
                <div style={{
                    textAlign: "center", color: "var(--text-secondary)",
                    marginTop: "-0.3em", marginBottom: "0.4em",
                    display: "flex", flexWrap: "wrap", alignItems: "center",
                    justifyContent: "center", gap: 6, fontSize: "0.95em",
                }}>
                    <span>{severityPhrase} crashes</span>
                    {scopeLabel && <><span>·</span><span>{scopeLabel}</span></>}
                    <span>·</span>
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
                </div>
            )}
        <div
            ref={wrapRef}
            style={{ position: "relative", height, width: "100%", borderRadius: 4, overflow: "hidden" }}
        >
            {result.status === "error" && (
                <div style={{ padding: "1em", color: "red" }}>Error: {result.error}</div>
            )}
            {result.status === "loading" && <LoadingOverlay theme={actualTheme} />}
            {result.status === "ready" && (
                <Suspense fallback={<LoadingOverlay theme={actualTheme} />}>
                    {scale === "detail" ? (
                        <CrashMap
                            crashes={result.data as Crash[]}
                            outline={outline ?? undefined}
                            muniOutline={muniOutline ?? undefined}
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
                            yearSpan={yearRange[1] - yearRange[0] + 1}
                        />
                    ) : (
                        <CrashMap
                            prebinnedHexes={result.data as StackedHex[]}
                            outline={outline ?? undefined}
                            muniOutline={muniOutline ?? undefined}
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
                            yearSpan={yearRange[1] - yearRange[0] + 1}
                        />
                    )}
                </Suspense>
            )}
            {!drawerOpen && (
                <>
                    <button
                        onClick={() => setDrawerOpen(true)}
                        title="Show controls"
                        aria-label="Show map controls"
                        style={{
                            position: "absolute", top: 8, right: 8, background: bg, color: fg,
                            padding: "0.25em 0.5em", borderRadius: 4, zIndex: 1000,
                            border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                            cursor: "pointer", fontSize: "1em", lineHeight: 1,
                        }}
                    >⚙</button>
                    {llz && (
                        <button
                            onClick={() => setLlz(null)}
                            title="Reset view"
                            aria-label="Reset map view"
                            style={{
                                position: "absolute", top: 8, right: 40, background: bg, color: fg,
                                width: 24, height: 24, padding: 0, borderRadius: 4, zIndex: 1000,
                                border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                                cursor: "pointer", fontSize: "0.95em", lineHeight: 1,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                            }}
                        >↺</button>
                    )}
                </>
            )}
            {drawerOpen && (
            <div style={{
                position: "absolute", top: 8, right: 8, background: bg, color: fg,
                padding: "0.4em 0.6em", borderRadius: 4, zIndex: 1000, fontSize: "0.82em",
                display: "flex", flexDirection: "column", gap: 6, minWidth: 210, maxWidth: 260,
            }}>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, alignItems: "center", marginBottom: -4 }}>
                    {llz && (
                        <button
                            onClick={() => setLlz(null)}
                            title="Reset view"
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
            {fullScreenHref && (
                <a
                    href={fullScreenHref}
                    title="Open full-screen"
                    aria-label="Open map in full-screen view"
                    style={{
                        position: "absolute", bottom: 8, right: 8, zIndex: 1000,
                        background: bg, color: fg,
                        padding: "0.3em", borderRadius: 4,
                        border: `1px solid ${actualTheme === "dark" ? "#444" : "#ccc"}`,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        textDecoration: "none", lineHeight: 1,
                    }}
                >
                    <FiMaximize2 size={14} />
                </a>
            )}
            <Legend
                theme={actualTheme}
                pdoEnabled={scale === "r8" || (result.manifest?.point_severities?.includes("p") ?? false)}
                severities={severities}
                onToggle={toggleSeverity}
            />
            {emptySeverities && result.status === "ready" && (
                <div style={{
                    position: "absolute", inset: 0, zIndex: 900,
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

function Legend({
    theme, pdoEnabled, severities, onToggle,
}: {
    theme: "light" | "dark"
    pdoEnabled: boolean
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
            position: "absolute", top: 8, left: 8, zIndex: 1000,
            background: bg, color: fg, padding: "4px 8px", borderRadius: 4,
            fontSize: "0.72em", display: "flex", flexDirection: "column", gap: 2,
            border: `1px solid ${theme === "dark" ? "#444" : "#ccc"}`,
        }}>
            {items.map(it => {
                const showable = it.key !== "p" || pdoEnabled
                const on = showable && severities.has(it.key)
                return (
                    <button
                        key={it.key}
                        disabled={!showable}
                        title={!showable
                            ? "Other only available in statewide + Hexbin mode"
                            : on ? `Hide ${it.label}` : `Show ${it.label}`}
                        aria-pressed={on}
                        onClick={() => showable && onToggle(it.key)}
                        style={{
                            display: "flex", alignItems: "center", gap: 6,
                            opacity: on ? 1 : 0.4,
                            background: "transparent", color: fg, border: "none", padding: 0,
                            cursor: showable ? "pointer" : "not-allowed",
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

function YearSelect({
    value, min, max, onChange, theme,
}: {
    value: number
    min: number
    max: number
    onChange: (y: number) => void
    theme: "light" | "dark"
}) {
    const bg = theme === "dark" ? "#2a2a2a" : "#fff"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const border = `1px solid ${theme === "dark" ? "#444" : "#ccc"}`
    const opts: number[] = []
    for (let y = min; y <= max; y++) opts.push(y)
    return (
        <select
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            style={{
                background: bg, color: fg, border, borderRadius: 3,
                padding: "1px 4px", fontSize: "0.95em",
            }}
        >
            {opts.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
    )
}
