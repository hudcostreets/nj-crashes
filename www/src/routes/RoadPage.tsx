/** `/road/<slug>` (e.g. `/road/hudson/jersey-city/west-side-avenue`): a road entity's summary, map,
 *  crashes over time, and crash table (specs/road-data-v4.md). Numeric `/road/<entity>` (old links;
 *  ids aren't stable across builds) redirects to the slug. Data: the `roads/` parquets, read with
 *  DuckDB-WASM ranged reads; the per-year / per-month summary renders before the crash list. */
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
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
    fetchEntityGeom, fetchEntitySummary, isUnplaced, isV5, roadPaths, type RoadSummaryRow,
} from "@/src/map/roads/roadsData"
import { crashHref, ExportCsvButton, RoadCrashTable, UnplacedNote } from "@/src/map/roads/RoadCrashTable"
import { isPinned } from "@/src/map/roads/roadScope"
import { unplacedTotal } from "@/src/map/roads/roadStats"
import { RoadPlots } from "@/src/map/roads/RoadPlots"
import { ScopeBar } from "@/src/map/roads/ScopeBar"
import { scopeSql } from "@/src/map/roads/scopeSql"
import { parseRoadRef, useRoadEntity } from "@/src/map/roads/useRoadEntity"
import { useRoadScope, type ScopeCrash } from "@/src/map/roads/useRoadScope"
import css from "@/src/home.module.scss"

const RoadMap = lazy(() => import("@/src/map/roads/RoadMap"))

const MAP_HEIGHT = 450
const PAGE_SIZE = 100

type Order = "date" | "mp"

type Bbox = [number, number, number, number]

function pathsBbox(paths: [number, number][][]): Bbox | null {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const p of paths) for (const [x, y] of p) {
        if (x < w) w = x
        if (x > e) e = x
        if (y < s) s = y
        if (y > n) n = y
    }
    if (!isFinite(w)) return null
    // Pad short spans, so a block isn't zoomed to fill the map.
    const px = Math.max((e - w) * 0.15, 0.002), py = Math.max((n - s) * 0.15, 0.0015)
    return [w - px, s - py, e + px, n + py]
}

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
        staleTime: Infinity,
    })
    const geom = useQuery({ queryKey: ["road-geom", entity], queryFn: () => fetchEntityGeom(db!, entity!), enabled, staleTime: Infinity })
    const scope = useRoadScope({
        info: typeof ref === "string" ? info.data ?? null : null,
        geom: geom.data ?? null,
        roadSummary: summary.data ?? null,
        hotkeys: true,
    })
    const v5 = isV5(info.data)

    const paths = useMemo(() => roadPaths(geom.data ?? []), [geom.data])
    const { span } = scope
    const corridorScope = scope.state.corridor
    // Corridor: all members' paths; a span: highlighted on its road(s).
    const basePaths = corridorScope && !span && scope.paths.length ? scope.paths : paths
    const highlight = span ? scope.paths : undefined
    useEffect(() => setPage(0), [span?.lo, span?.hi, corridorScope, scope.inclusive])
    const sorted = useMemo((): ScopeCrash[] => {
        const rows = scope.crashes ?? []
        // The scope's list is along the road (or SRI / MP on v4), crashes without a location last;
        // newest-first keeps those last too.
        const noLoc = (c: ScopeCrash) => Number(isUnplaced(c) && !isPinned(c))
        return order === "mp" ? rows : [...rows].sort((a, b) => noLoc(a) - noLoc(b) || b.dt - a.dt)
    }, [scope.crashes, order])
    const nUnplaced = useMemo(() => unplacedTotal(summary.data ?? []), [summary.data])
    const nPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
    const pageRows = useMemo(() => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [sorted, page])
    const roadNames = useMemo(
        () => (corridorScope ? new Map(scope.corridorMembers.map(m => [m.entity, m.name])) : undefined),
        [corridorScope, scope.corridorMembers],
    )
    const scopeBounds = useMemo(
        () => (span ? pathsBbox(scope.paths) : corridorScope && scope.corridor
            ? [scope.corridor.lon_min, scope.corridor.lat_min, scope.corridor.lon_max, scope.corridor.lat_max] as Bbox
            : null),
        [span, scope.paths, corridorScope, scope.corridor],
    )

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

    const bounds: Bbox = scopeBounds ?? [road.lon_min, road.lat_min, road.lon_max, road.lat_max]
    const multiSri = sris.length > 1
    const sqlHref = `/sql?q=${encodeURIComponent(scopeSql(road.entity, v5, scope) + ";")}`
    const mapHref = mapViewHref({
        lat: (bounds[1] + bounds[3]) / 2,
        lon: (bounds[0] + bounds[2]) / 2,
        zoom: span ? 16 : 13,
        road: road.slug,
    }) + (span ? `&span=${span.lo.toFixed(3)}-${span.hi.toFixed(3)}` : "") + (corridorScope ? "&cor" : "")
        + (v5 && !scope.inclusive ? "&xs=0" : "")
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
            <ScopeBar scope={scope} theme={theme} style={{ margin: "0.8em 0" }} />
            {!span && !corridorScope && <UnplacedNote n={nUnplaced} dim={dim} style={{ marginTop: "-0.4em", marginBottom: "1em" }} />}

            <h2 id="map">Map</h2>
            <Suspense fallback={<div style={{ height: MAP_HEIGHT }} />}>
                <RoadMap
                    paths={basePaths}
                    highlight={highlight}
                    crashes={scope.crashes ?? []}
                    bounds={bounds}
                    theme={theme}
                    height={MAP_HEIGHT}
                    onCrashClick={c => navigate(crashHref(c))}
                />
            </Suspense>
            {scope.crashesLoading && <p style={{ color: dim, fontSize: "0.85em" }}>Loading crashes…</p>}

            <h2 id="over-time">Over time</h2>
            {scope.summary
                ? <RoadPlots rows={scope.summary as (RoadSummaryRow & { month: number })[]} />
                : <p style={{ color: dim }}>{summary.isError ? `Error: ${summary.error}` : "Loading…"}</p>}

            <h2 id="crashes">Crashes</h2>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <ExportCsvButton entity={road.entity} slug={road.slug} v5={v5} disabled={road.n_crashes === 0} style={btn} />
                <a style={{ ...btn, textDecoration: "none" }} href={sqlHref} target="_blank" rel="noreferrer">Open in SQL ↗</a>
                <span style={{ marginLeft: "auto", color: dim, fontSize: "0.85em" }}>
                    Order:{" "}
                    <select value={order} onChange={e => { setOrder(e.target.value as Order); setPage(0) }}>
                        <option value="date">Newest first</option>
                        <option value="mp">{v5 ? "Along the road" : "SRI, milepost"}</option>
                    </select>
                </span>
            </div>
            {scope.crashes && <>
                <RoadCrashTable rows={pageRows} multiSri={multiSri} v5={v5} roadNames={roadNames} chainOf={scope.displayChain} theme={theme} headerBg={theme === "dark" ? "#1e1e1e" : "#fff"} />
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
