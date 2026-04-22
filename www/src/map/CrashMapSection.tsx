/** Embeddable crash-map panel for Home.tsx geo-filtered pages.
 *
 *  Scope (cc, mc) comes from the caller. Otherwise mirrors the
 *  standalone `/map` route: year-range slider, severity toggle, mode
 *  toggle (hexbin default), outline overlay, fit-bounds on scope.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { useCrashData } from "@/src/map/useCrashData"
import type { CrashFilter } from "@/src/map/useCrashData"
import type { Crash, MapMode } from "@/src/map/CrashMap"
import type { StackedHex } from "@/src/map/StackedHexLayer"
import { useTheme } from "@/src/contexts/ThemeContext"
import type { FeatureCollection } from "geojson"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

const STATE_BBOX: [number, number, number, number] = [-75.7, 38.9, -73.9, 41.4]

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
                            mode={mode}
                            theme={actualTheme}
                            height={height}
                        />
                    ) : (
                        <CrashMap
                            prebinnedHexes={result.data as StackedHex[]}
                            outline={outline ?? undefined}
                            initialBounds={initialBounds}
                            mode="hexbin"
                            theme={actualTheme}
                            height={height}
                        />
                    )}
                </Suspense>
            )}
            <div style={{
                position: "absolute", top: 8, left: 8, background: bg, color: fg,
                padding: "0.4em 0.6em", borderRadius: 4, zIndex: 1000, fontSize: "0.82em",
                display: "flex", flexDirection: "column", gap: 6, maxWidth: 260,
            }}>
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
                    {(["f", "i"] as const).map(s => {
                        const checked = severities.has(s)
                        const label = s === "f" ? "Fatal" : "Injury"
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
        </div>
    )
}
