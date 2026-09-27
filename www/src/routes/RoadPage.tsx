/** `/road/<slug>` (e.g. `/road/hudson/jersey-city/west-side-avenue`): a road entity's summary, map,
 *  crashes over time, and crash table (specs/road-data-v4.md). Numeric `/road/<entity>` (old links;
 *  ids aren't stable across builds) redirects to the slug. Data: the `roads/` parquets, read with
 *  DuckDB-WASM ranged reads; the per-year / per-month summary renders before the crash list. */
import { lazy, Suspense, useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Head } from "@/src/lib/head"
import { url as siteUrl } from "@/src/site"
import { useDb } from "@/src/lib/DuckDbContext"
import { loadCC2MC2MN } from "@/src/lib/data"
import { normalize } from "@/src/county"
import { useTheme } from "@/src/contexts/ThemeContext"
import { mapViewHref } from "@/src/map/links"
import {
    entityCrashesSql, fetchEntityCrashes, fetchEntityGeom, fetchEntitySummary, roadPaths, type RoadCrashView,
    type RoadSummaryRow,
} from "@/src/map/roads/roadsData"
import { crashHref, ExportCsvButton, RoadCrashTable } from "@/src/map/roads/RoadCrashTable"
import { RoadPlots } from "@/src/map/roads/RoadPlots"
import { parseRoadRef, useRoadEntity } from "@/src/map/roads/useRoadEntity"
import css from "@/src/home.module.scss"

const RoadMap = lazy(() => import("@/src/map/roads/RoadMap"))

const MAP_HEIGHT = 450
const PAGE_SIZE = 100

type Order = "date" | "mp"

export default function RoadPage() {
    const params = useParams()
    const ref = parseRoadRef(params["*"])
    const db = useDb()
    const navigate = useNavigate()
    const { actualTheme: theme } = useTheme()
    const [order, setOrder] = useState<Order>("date")
    const [page, setPage] = useState(0)
    const { data: cc2mc2mn = null } = useQuery({ queryKey: ["cc2mc2mn"], queryFn: loadCC2MC2MN, staleTime: Infinity })

    const info = useRoadEntity(ref)
    const entity = typeof ref === "string" ? info.data?.entity ?? null : null
    const enabled = !!db && entity !== null
    const sris = useMemo(() => info.data?.sris.split(",") ?? [], [info.data])
    const summary = useQuery({
        queryKey: ["road-summary-monthly", entity],
        queryFn: () => fetchEntitySummary(db!, entity!, true) as Promise<(RoadSummaryRow & { month: number })[]>,
        enabled,
    })
    const geom = useQuery({ queryKey: ["road-geom", entity], queryFn: () => fetchEntityGeom(db!, entity!), enabled })
    const crashes = useQuery({ queryKey: ["road-crashes", entity], queryFn: () => fetchEntityCrashes(db!, entity!), enabled })

    const paths = useMemo(() => roadPaths(geom.data ?? []), [geom.data])
    const sorted = useMemo((): RoadCrashView[] => {
        const rows = crashes.data ?? []
        // The query returns (sri, mp, dt) order.
        return order === "mp" ? rows : [...rows].sort((a, b) => b.dt - a.dt)
    }, [crashes.data, order])
    const nPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
    const pageRows = useMemo(() => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [sorted, page])

    const dim = theme === "dark" ? "#999" : "#666"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const btn = { padding: "2px 8px", fontSize: "0.85em", background: "transparent", color: fg, border: `1px solid ${dim}`, borderRadius: 3, cursor: "pointer" }

    if (typeof ref === "number" && info.data) {
        return <Navigate to={`/road/${info.data.slug}`} replace />
    }
    if (ref === null || (info.isSuccess && !info.data)) {
        return <div className={css.container}>
            <main className={css.main}>
                <Head title="Road not found" description="" url={siteUrl} />
                <h1>Road not found</h1>
                <p>No road <code>{params["*"]}</code>.</p>
            </main>
        </div>
    }
    const road = info.data
    if (!road || typeof ref === "number") {
        return <div className={css.container}>
            <main className={css.main}><p>{info.isError ? `Error: ${info.error}` : "Loading…"}</p></main>
        </div>
    }

    const bounds: [number, number, number, number] = [road.lon_min, road.lat_min, road.lon_max, road.lat_max]
    const multiSri = sris.length > 1
    const sqlHref = `/sql?q=${encodeURIComponent(entityCrashesSql(road.entity) + ";")}`
    const mapHref = mapViewHref({
        lat: (road.lat_min + road.lat_max) / 2,
        lon: (road.lon_min + road.lon_max) / 2,
        zoom: 13,
        road: road.slug,
    })
    const county = road.cc !== null ? cc2mc2mn?.[road.cc] : undefined
    const muniName = county && road.mc !== null ? county.mc2mn[road.mc] : undefined

    return <div className={css.container}>
        <Head
            title={`${road.name} · road crashes`}
            description={`${road.n_crashes.toLocaleString()} crashes, ${road.n_killed.toLocaleString()} killed, on ${road.name}`}
            url={`${siteUrl}/road/${road.slug}`}
        />
        <main className={css.main}>
            <p style={{ fontSize: "0.85em" }}>
                {county && <Link to={`/c/${normalize(county.cn)}`}>{county.cn} County</Link>}
                {county && muniName && <> · <Link to={`/c/${normalize(county.cn)}/${normalize(muniName)}`}>{muniName}</Link></>}
                {county && " · "}<Link to={mapHref}>View on crash map</Link>
            </p>
            <h1 style={{ marginBottom: "0.2em" }}>
                {road.name}
                {road.route && <span style={{ fontWeight: "normal", color: dim }}> · on {road.route}</span>}
            </h1>
            {road.aliases && <p style={{ margin: 0, color: dim }}>Also reported as: {road.aliases}</p>}
            <p style={{ margin: 0, color: dim, fontSize: "0.85em" }}>
                {road.length_mi > 0 && <>{road.length_mi.toFixed(1)} mi · </>}
                {!muniName && road.munis && <>{road.munis} · </>}
                SRI{multiSri ? "s" : ""} {sris.join(", ")}
            </p>
            <p>
                <b>{road.n_crashes.toLocaleString()}</b> crashes · <b>{road.n_fatal.toLocaleString()}</b> fatal
                {" "}(<b>{road.n_killed.toLocaleString()}</b> killed) · <b>{road.n_injury.toLocaleString()}</b> injury
            </p>

            <h2 id="map">Map</h2>
            <Suspense fallback={<div style={{ height: MAP_HEIGHT }} />}>
                <RoadMap
                    paths={paths}
                    crashes={crashes.data ?? []}
                    bounds={bounds}
                    theme={theme}
                    height={MAP_HEIGHT}
                    onCrashClick={c => navigate(crashHref(c))}
                />
            </Suspense>
            {crashes.isFetching && <p style={{ color: dim, fontSize: "0.85em" }}>Loading crashes…</p>}

            <h2 id="over-time">Over time</h2>
            {summary.data ? <RoadPlots rows={summary.data} /> : <p style={{ color: dim }}>{summary.isError ? `Error: ${summary.error}` : "Loading…"}</p>}

            <h2 id="crashes">Crashes</h2>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <ExportCsvButton entity={road.entity} slug={road.slug} disabled={road.n_crashes === 0} style={btn} />
                <a style={{ ...btn, textDecoration: "none" }} href={sqlHref} target="_blank" rel="noreferrer">Open in SQL ↗</a>
                <span style={{ marginLeft: "auto", color: dim, fontSize: "0.85em" }}>
                    Order:{" "}
                    <select value={order} onChange={e => { setOrder(e.target.value as Order); setPage(0) }}>
                        <option value="date">Newest first</option>
                        <option value="mp">SRI, milepost</option>
                    </select>
                </span>
            </div>
            {crashes.data && <>
                <RoadCrashTable rows={pageRows} multiSri={multiSri} theme={theme} headerBg={theme === "dark" ? "#1e1e1e" : "#fff"} />
                {nPages > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: "0.85em" }}>
                        <button style={btn} disabled={page === 0} onClick={() => setPage(0)}>«</button>
                        <button style={btn} disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</button>
                        <span>
                            {(page * PAGE_SIZE + 1).toLocaleString()}–{Math.min(sorted.length, (page + 1) * PAGE_SIZE).toLocaleString()} of {sorted.length.toLocaleString()}
                        </span>
                        <button style={btn} disabled={page >= nPages - 1} onClick={() => setPage(p => p + 1)}>›</button>
                        <button style={btn} disabled={page >= nPages - 1} onClick={() => setPage(nPages - 1)}>»</button>
                    </div>
                )}
            </>}
        </main>
    </div>
}
