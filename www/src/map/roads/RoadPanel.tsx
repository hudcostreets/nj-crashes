import { useMemo } from "react"
import { Link } from "react-router-dom"
import { EndYear, StartYear } from "@/src/constants"
import { entityCrashesSql, type RoadCrashView, type RoadEntity, type RoadSummaryRow } from "./roadsData"
import { ExportCsvButton, RoadCrashTable, UnplacedNote } from "./RoadCrashTable"
import { unplacedTotal, yearStats } from "./roadStats"
import { YearStrip } from "./YearStrip"

/** Rows rendered in the panel; the CSV export always has all of them. */
const TABLE_ROWS = 300

export type RoadPanelProps = {
    /** Null while loading (or when `?road=` names no road). */
    info: RoadEntity | null
    notFound: boolean
    /** The road's `road-summary` rows (per year × severity). */
    summary: RoadSummaryRow[] | null
    crashes: RoadCrashView[] | null
    loading: boolean
    onClose: () => void
    onZoomTo: (bbox: [number, number, number, number]) => void
    theme: "light" | "dark"
}

/** Selected-road summary + crash table (specs/road-name-normalization-and-search.md Layer 4b). */
export function RoadPanel({ info, notFound, summary, crashes, loading, onClose, onZoomTo, theme }: RoadPanelProps) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const rows = useMemo(() => crashes?.slice(0, TABLE_ROWS) ?? [], [crashes])
    const stats = useMemo(() => (summary?.length ? yearStats(summary, StartYear, EndYear) : null), [summary])
    const nUnplaced = useMemo(() => unplacedTotal(summary ?? []), [summary])
    const sris = info?.sris.split(",") ?? []
    const multiSri = sris.length > 1
    const btn = { padding: "2px 8px", fontSize: "0.8em", background: "transparent", color: fg, border: `1px solid ${dim}`, borderRadius: 3, cursor: "pointer" }
    return (
        <div style={{
            position: "absolute", left: 8, bottom: 40, zIndex: 3, width: 460, maxWidth: "calc(100% - 16px)",
            maxHeight: "45%", display: "flex", flexDirection: "column",
            background: bg, color: fg, borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.4)", fontSize: 13,
        }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${dim}` }}>
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
                {info && (
                    <div style={{ marginTop: 4 }}>
                        {info.n_crashes.toLocaleString()} crashes · {info.n_fatal.toLocaleString()} fatal
                        ({info.n_killed.toLocaleString()} killed) · {info.n_injury.toLocaleString()} injury
                    </div>
                )}
                <UnplacedNote n={nUnplaced} dim={dim} />
                {info && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button style={btn} onClick={() => onZoomTo([info.lon_min, info.lat_min, info.lon_max, info.lat_max])}>Zoom to road</button>
                        <ExportCsvButton entity={info.entity} slug={info.slug} disabled={info.n_crashes === 0} style={btn} />
                        <a style={{ ...btn, textDecoration: "none" }} href={`/sql?q=${encodeURIComponent(entityCrashesSql(info.entity) + ";")}`} target="_blank" rel="noreferrer">Open in SQL ↗</a>
                        <Link style={{ ...btn, textDecoration: "none", marginLeft: "auto" }} to={`/road/${info.slug}`}>Open road page →</Link>
                    </div>
                )}
                {stats && <YearStrip stats={stats} dim={dim} />}
            </div>
            <div style={{ overflow: "auto" }}>
                {loading && info && !crashes && <div style={{ padding: 10, color: dim }}>Loading crashes…</div>}
                {crashes && <RoadCrashTable rows={rows} multiSri={multiSri} theme={theme} headerBg={bg} />}
                {crashes && crashes.length > TABLE_ROWS && (
                    <div style={{ padding: "4px 10px", color: dim, fontSize: "0.8em" }}>
                        Showing {TABLE_ROWS} of {crashes.length.toLocaleString()} (by SRI, MP; street-name-only last) — export for all.
                    </div>
                )}
            </div>
        </div>
    )
}
