import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useEffect, useMemo, useState } from "react"
import { decode, Encoded } from "@/src/indexed-json"
import { Crash } from "@/src/map/types"
import { useMapState } from "@/src/map/hudson/state"
import type { FeatureCollection } from "geojson"
import css from "@/src/map/hudson/map.module.scss"

// Lazy load the map component to avoid SSR issues with Leaflet
import { lazy, Suspense } from "react"
const Map = lazy(() => import("@/src/map/hudson"))

export default function HudsonMap() {
    const [crashes, setCrashes] = useState<Crash[] | null>(null)
    const [hudco, setHudco] = useState<FeatureCollection | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const mapState = useMapState()

    useEffect(() => {
        async function loadData() {
            try {
                const [crashesRes, hudcoRes] = await Promise.all([
                    fetch("/plots/njdot/hudson-5yr-lls-if.json"),
                    fetch("/hudson.geojson"),
                ])

                if (!crashesRes.ok) throw new Error("Failed to load crash data")
                if (!hudcoRes.ok) throw new Error("Failed to load county boundary")

                const encodedCrashes: Encoded = await crashesRes.json()
                const hudcoData: FeatureCollection = await hudcoRes.json()

                const decodedCrashes = decode<Crash>(encodedCrashes)
                setCrashes(decodedCrashes)
                setHudco(hudcoData)
                setLoading(false)
            } catch (e) {
                setError(e instanceof Error ? e.message : "Unknown error")
                setLoading(false)
            }
        }
        loadData()
    }, [])

    // Stats from original page
    const numKsiCrashes = 15_983
    const numPropCrashes = 73_697
    const stats = { tk: 127, ti: 21_112, tv: 178_093 }

    return (
        <div className={css.container}>
            <Head
                title="Hudson County Crash Map"
                description="Interactive map of crash locations in Hudson County, NJ"
                url={url}
            />
            {loading && <div style={{ padding: "1em" }}>Loading crash data...</div>}
            {error && <div style={{ padding: "1em", color: "red" }}>Error: {error}</div>}
            {crashes && hudco && (
                <Suspense fallback={<div style={{ padding: "1em" }}>Loading map...</div>}>
                    <Map
                        {...mapState}
                        crashes={crashes}
                        hudco={hudco}
                    />
                </Suspense>
            )}
            <div className={css.info} style={{
                position: "absolute",
                bottom: "1em",
                left: "1em",
                background: "rgba(255,255,255,0.9)",
                padding: "0.5em 1em",
                borderRadius: "4px",
                maxWidth: "300px",
                zIndex: 1000,
            }}>
                <p className={css.heading}>Hudson County fatal / serious injury crashes, 2017-2021</p>
                <p>{numKsiCrashes.toLocaleString()} KSI crashes{crashes ? `, ${crashes.length.toLocaleString()} with approximate locations plotted` : ""}</p>
                <p>Not pictured: {numPropCrashes.toLocaleString()} property damage crashes.</p>
                <p>Total: {stats.tk.toLocaleString()} killed, {stats.ti.toLocaleString()} injured, {stats.tv.toLocaleString()} vehicles</p>
                <p><a href="/">← Back to Home</a></p>
            </div>
        </div>
    )
}
