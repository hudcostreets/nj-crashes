import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useEffect, useState } from "react"
import { decode, Encoded } from "@/src/indexed-json"
import { useTheme } from "@/src/contexts/ThemeContext"
import type { FeatureCollection } from "geojson"
import css from "@/src/map/hudson/map.module.scss"
import { lazy, Suspense } from "react"
import type { Crash, MapMode } from "@/src/map/CrashMap"

const CrashMap = lazy(() => import("@/src/map/CrashMap").then(m => ({ default: m.CrashMap })))

// Hudson County bounding box (approx)
const HUDSON_BOUNDS: [number, number, number, number] = [-74.16, 40.64, -73.98, 40.80]

export default function HudsonMap() {
    const [crashes, setCrashes] = useState<Crash[] | null>(null)
    const [hudco, setHudco] = useState<FeatureCollection | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [mode, setMode] = useState<MapMode>("scatter")

    const { actualTheme } = useTheme()

    useEffect(() => {
        async function loadData() {
            try {
                const [crashesRes, hudcoRes] = await Promise.all([
                    fetch("/plots/njdot/hudson-5yr-lls-if.json"),
                    fetch("/hudson.geojson"),
                ])
                if (!crashesRes.ok) throw new Error("Map data not available — run `tmp/regen_hudson_map.py`")
                if (!hudcoRes.ok) throw new Error("County boundary file not found")
                const [encodedCrashes, hudcoData] = await Promise.all([
                    crashesRes.json() as Promise<Encoded>,
                    hudcoRes.json() as Promise<FeatureCollection>,
                ])
                setCrashes(decode<Crash>(encodedCrashes))
                setHudco(hudcoData)
            } catch (e) {
                setError(e instanceof Error ? e.message : "Unknown error")
            }
        }
        loadData()
    }, [])

    const yearRange = "2019-2023"
    const numKsiCrashes = 12_758
    const numPropCrashes = 54_047
    const stats = { tk: 104, ti: 16_812, tv: 132_515 }

    return (
        <div className={css.container}>
            <Head
                title="Hudson County Crash Map"
                description="Interactive map of crash locations in Hudson County, NJ"
                url={url}
            />
            {error && <div style={{ padding: "1em", color: "red" }}>Error: {error}</div>}
            {!error && !crashes && <div style={{ padding: "1em" }}>Loading crash data…</div>}
            {crashes && hudco && (
                <Suspense fallback={<div style={{ padding: "1em" }}>Loading map…</div>}>
                    <CrashMap
                        crashes={crashes}
                        outline={hudco}
                        initialBounds={HUDSON_BOUNDS}
                        mode={mode}
                        theme={actualTheme}
                    />
                </Suspense>
            )}

            <ModeToggle mode={mode} setMode={setMode} theme={actualTheme} />

            <div className={css.info} style={{
                position: "absolute",
                bottom: "1em",
                left: "1em",
                background: actualTheme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)",
                color: actualTheme === "dark" ? "#e0e0e0" : "#333",
                padding: "0.5em 1em",
                borderRadius: 4,
                maxWidth: 300,
                zIndex: 1000,
            }}>
                <p className={css.heading}>Hudson County fatal / serious injury crashes, {yearRange}</p>
                <p>{numKsiCrashes.toLocaleString()} KSI crashes{crashes ? `, ${crashes.length.toLocaleString()} plotted` : ""}</p>
                <p>Not pictured: {numPropCrashes.toLocaleString()} property-damage crashes.</p>
                <p>Total: {stats.tk.toLocaleString()} killed, {stats.ti.toLocaleString()} injured, {stats.tv.toLocaleString()} vehicles</p>
                <p><a href="/" style={{ color: actualTheme === "dark" ? "#6db3f2" : "#0066cc" }}>← Home</a></p>
            </div>
        </div>
    )
}

function ModeToggle({ mode, setMode, theme }: { mode: MapMode; setMode: (m: MapMode) => void; theme: "light" | "dark" }) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const activeBg = theme === "dark" ? "#6db3f2" : "#0066cc"
    const items: [MapMode, string][] = [["scatter", "Points"], ["heatmap", "Heatmap"], ["hexbin", "Hexbin"]]
    return (
        <div style={{
            position: "absolute", top: "1em", right: "1em", background: bg, color: fg,
            padding: "0.3em", borderRadius: 4, zIndex: 1000, display: "flex", gap: 4,
        }}>
            {items.map(([m, label]) => (
                <button
                    key={m}
                    onClick={() => setMode(m)}
                    style={{
                        padding: "0.3em 0.7em",
                        cursor: "pointer",
                        background: mode === m ? activeBg : "transparent",
                        color: mode === m ? "#fff" : fg,
                        border: "1px solid " + (mode === m ? activeBg : fg),
                        borderRadius: 3,
                        fontSize: "0.85em",
                    }}
                >{label}</button>
            ))}
        </div>
    )
}
