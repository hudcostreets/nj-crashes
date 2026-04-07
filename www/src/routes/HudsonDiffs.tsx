import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import { useEffect, useState } from "react"
import { decode, Encoded } from "@/src/indexed-json"
import { CrashDiff } from "@/src/map/types"
import { useMapState } from "@/src/map/hudson/state"
import type { FeatureCollection, MultiPolygon } from "geojson"
import css from "@/src/map/hudson/map.module.scss"

// Lazy load the map component to avoid SSR issues with Leaflet
import { lazy, Suspense } from "react"
const Map = lazy(() => import("@/src/map/hudson/diffs"))

export default function HudsonDiffs() {
    const [crashes, setCrashes] = useState<CrashDiff[] | null>(null)
    const [hudco, setHudco] = useState<FeatureCollection<MultiPolygon> | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const mapState = useMapState()

    useEffect(() => {
        async function loadData() {
            try {
                const [crashesRes, hudcoRes] = await Promise.all([
                    fetch("/plots/njdot/hudson-5yr-lls-if-diffs.json"),
                    fetch("/hudson.geojson"),
                ])

                if (!crashesRes.ok) throw new Error("Failed to load crash diff data")
                if (!hudcoRes.ok) throw new Error("Failed to load county boundary")

                const encodedCrashes: Encoded = await crashesRes.json()
                const hudcoData = await hudcoRes.json() as FeatureCollection<MultiPolygon>

                const decodedCrashes = decode<CrashDiff>(encodedCrashes)
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

    return (
        <div className={css.container}>
            <Head
                title="Hudson County Crash Location Diffs"
                description="Visualization of crash location corrections in Hudson County, NJ"
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
            <div style={{
                position: "absolute",
                bottom: "1em",
                left: "1em",
                background: "rgba(255,255,255,0.9)",
                padding: "0.5em 1em",
                borderRadius: "4px",
                maxWidth: "300px",
                zIndex: 1000,
            }}>
                <p><strong>Hudson County Crash Location Corrections</strong></p>
                <p>Red: corrected location, Blue: original location</p>
                <p>{crashes?.length.toLocaleString() ?? "..."} crashes with location diffs</p>
                <p><a href="/map/hudson">← Main Hudson Map</a></p>
                <p><a href="/">← Back to Home</a></p>
            </div>
        </div>
    )
}
