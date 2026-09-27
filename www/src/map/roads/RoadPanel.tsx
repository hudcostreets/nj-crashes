import { useMemo } from "react"
import { Link } from "react-router-dom"
import { EndYear, StartYear } from "@/src/constants"
import { isV5, type RoadEntity, type RoadSummaryRow } from "./roadsData"
import { ExportCsvButton, RoadCrashTable, UnplacedNote } from "./RoadCrashTable"
import { noteBands } from "./roadNotes"
import { DataNotes, noteColors } from "./DataNotes"
import { unplacedTotal, yearStats } from "./roadStats"
import { ScopeBar } from "./ScopeBar"
import { scopeSql } from "./scopeSql"
import { useRoadNotes } from "./useRoadNotes"
import type { RoadScope } from "./useRoadScope"
import { YearStrip } from "./YearStrip"

/** Rows rendered in the panel; the CSV export always has all of them. */
const TABLE_ROWS = 300

export type RoadPanelProps = {
    /** Null while loading (or when `?road=` names no road). */
    info: RoadEntity | null
    notFound: boolean
    /** The road's `road-summary` rows (per year × severity). */
    roadSummary: RoadSummaryRow[] | null
    scope: RoadScope
    onClose: () => void
    onZoomTo: (bbox: [number, number, number, number]) => void
    /** The road page URL for the current scope (`/road/<slug>?span=…`). */
    pageHref: string | null
    theme: "light" | "dark"
}

/** Selected-road summary + crash table (specs/road-name-normalization-and-search.md Layer 4b), for
 *  the current scope (specs/road-model-v5.md). */
export function RoadPanel({ info, notFound, roadSummary, scope, onClose, onZoomTo, pageHref, theme }: RoadPanelProps) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const { crashes } = scope
    const rows = useMemo(() => crashes?.slice(0, TABLE_ROWS) ?? [], [crashes])
    const stats = useMemo(() => (scope.summary?.length ? yearStats(scope.summary, StartYear, EndYear) : null), [scope.summary])
    const nUnplaced = useMemo(() => unplacedTotal(roadSummary ?? []), [roadSummary])
    const notes = useRoadNotes(info, scope)
    const bands = useMemo(
        () => (stats?.years.length ? noteBands(notes, stats.years[0], stats.years[stats.years.length - 1]) : []),
        [notes, stats],
    )
    const sris = info?.sris.split(",") ?? []
    const multiSri = sris.length > 1
    const v5 = isV5(info)
    const roadNames = useMemo(
        () => (scope.state.corridor ? new Map(scope.corridorMembers.map(m => [m.entity, m.name])) : undefined),
        [scope.state.corridor, scope.corridorMembers],
    )
    const btn = { padding: "2px 8px", fontSize: "0.8em", background: "transparent", color: fg, border: `1px solid ${dim}`, borderRadius: 3, cursor: "pointer" }
    const zoomBbox = scope.state.corridor && scope.corridor
        ? [scope.corridor.lon_min, scope.corridor.lat_min, scope.corridor.lon_max, scope.corridor.lat_max] as [number, number, number, number]
        : info ? [info.lon_min, info.lat_min, info.lon_max, info.lat_max] as [number, number, number, number] : null
    return (
        <div data-road-panel style={{
            position: "absolute", left: 8, bottom: 40, zIndex: 3, width: 480, maxWidth: "calc(100% - 16px)",
            maxHeight: "55%", display: "flex", flexDirection: "column",
            background: bg, color: fg, borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.4)", fontSize: 13,
        }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${dim}`, overflow: "auto", flexShrink: 0, maxHeight: "60%" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <strong style={{ flex: 1 }}>
                        {info?.name ?? (notFound ? "Road not found" : "Loading…")}
                        {info?.route && <span style={{ fontWeight: "normal", color: dim }}> · on {info.route}</span>}
                    </strong>
                    <button onClick={onClose} style={{ ...btn, border: "none" }} aria-label="Clear road selection">✕</button>
                </div>
                {info?.aliases && (
                    <div style={{ color: dim, fontSize: "0.85em" }}>Also reported as: {info.aliases}</div>
                )}
                <div style={{ color: dim, fontSize: "0.8em" }}>
                    SRI{multiSri ? "s" : ""} {sris.join(", ")}
                </div>
                {info && <ScopeBar scope={scope} mapHints theme={theme} style={{ marginTop: 4 }} />}
                {!scope.span && !scope.state.corridor && <UnplacedNote n={nUnplaced} dim={dim} />}
                {info && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        {zoomBbox && <button style={btn} onClick={() => onZoomTo(zoomBbox)}>Zoom to {scope.state.corridor ? "corridor" : "road"}</button>}
                        <ExportCsvButton entity={info.entity} slug={info.slug} v5={v5} disabled={info.n_crashes === 0} style={btn} />
                        <a style={{ ...btn, textDecoration: "none" }} href={`/sql?q=${encodeURIComponent(scopeSql(info.entity, v5, scope) + ";")}`} target="_blank" rel="noreferrer">Open in SQL ↗</a>
                        {pageHref && <Link style={{ ...btn, textDecoration: "none", marginLeft: "auto" }} to={pageHref}>Open road page →</Link>}
                    </div>
                )}
                {stats && <YearStrip stats={stats} dim={dim} bands={bands} bandFill={noteColors(theme).band} />}
                <DataNotes notes={notes} theme={theme} compact corridorRoads={scope.state.corridor ? scope.corridor?.n_entities : undefined} style={{ marginTop: 6 }} />
            </div>
            <div style={{ overflow: "auto" }}>
                {scope.crashesLoading && info && !crashes && <div style={{ padding: 10, color: dim }}>Loading crashes…</div>}
                {crashes && <RoadCrashTable rows={rows} multiSri={multiSri} v5={v5} roadNames={roadNames} chainOf={scope.displayChain} corridorName={scope.corridor?.name} theme={theme} headerBg={bg} />}
                {crashes && crashes.length > TABLE_ROWS && (
                    <div style={{ padding: "4px 10px", color: dim, fontSize: "0.8em" }}>
                        Showing {TABLE_ROWS} of {crashes.length.toLocaleString()} ({v5 ? "along the road" : "by SRI, MP"}; no-location last) — export for all.
                    </div>
                )}
            </div>
        </div>
    )
}
