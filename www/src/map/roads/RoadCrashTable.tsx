/** A road's crash table + CSV export, shared by the map's `RoadPanel` and the road page. */
import { useState, type CSSProperties } from "react"
import { Link } from "react-router-dom"
import { useDb } from "@/src/lib/DuckDbContext"
import { Tooltip } from "@/src/tooltip"
import { fetchEntityCrashesFull, isUnplaced, type LocSource, type RoadCrash, type RoadCrashView } from "./roadsData"

const CSV_COLS: (keyof RoadCrash)[] = [
    "sri", "mp", "dt", "year", "cc", "mc", "case", "severity", "tk", "ti", "pk", "pi", "tv",
    "road", "cross_street", "route", "lat", "lon", "id", "loc_source",
]
export const SEVERITY: Record<string, string> = { f: "Fatal", i: "Injury", p: "Property" }

function csvCell(v: unknown): string {
    if (v === null || v === undefined) return ""
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** `slug`: the road's slug (`hudson/jersey-city/west-side-avenue` → `road-hudson_jersey-city_west-side-avenue.csv`). */
export function downloadCsv(slug: string, rows: RoadCrash[]) {
    const lines = [CSV_COLS.join(",")]
    for (const r of rows) {
        lines.push(CSV_COLS.map(c => csvCell(c === "dt" ? new Date(r.dt).toISOString() : r[c])).join(","))
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `road-${slug.replace(/\//g, "_")}.csv`
    a.click()
    URL.revokeObjectURL(url)
}

/** Exports every column of every crash on the road; the views only load the columns they show. */
export function ExportCsvButton({ entity, slug, disabled, style }: { entity: number; slug: string; disabled?: boolean; style: CSSProperties }) {
    const db = useDb()
    const [busy, setBusy] = useState(false)
    const onClick = async () => {
        if (!db) return
        setBusy(true)
        try {
            downloadCsv(slug, await fetchEntityCrashesFull(db, entity))
        } finally {
            setBusy(false)
        }
    }
    return <button style={style} disabled={disabled || busy || !db} onClick={onClick}>{busy ? "Exporting…" : "Export CSV"}</button>
}

export function crashHref(r: Pick<RoadCrash, "year" | "cc" | "mc" | "case">): string {
    return `/crash/${r.year}/${r.cc}/${r.mc}/${encodeURIComponent(r.case)}`
}

const UNPLACED_TIP: Partial<Record<LocSource, string>> = {
    name_only: "NJDOT didn't locate this crash (no route / milepost, as for most local-street crashes before 2018). The police report names this road, and no other road here by that name, so it's counted on this road, but its position along it is unknown: it's not on the map.",
    sri_only: "NJDOT coded this crash's route but no milepost. The route is this road here, so it's counted on this road, but its position along it is unknown: it's not on the map.",
}

/** "street name only" badge for crashes on the road without a map point, explained in a tooltip. */
export function UnplacedBadge({ source, theme }: { source: LocSource; theme: "light" | "dark" }) {
    const color = theme === "dark" ? "#bbb" : "#666"
    return (
        <Tooltip title={UNPLACED_TIP[source] ?? ""}>
            <span style={{
                display: "inline-block", padding: "0 5px", border: `1px dashed ${color}`, borderRadius: 8,
                color, fontSize: "0.85em", whiteSpace: "nowrap", cursor: "help",
            }}>
                {source === "sri_only" ? "route only" : "street name only"}
            </span>
        </Tooltip>
    )
}

/** "N crashes located by street name or route only (no map point)", when N > 0 (road page, map panel). */
export function UnplacedNote({ n, dim, style }: { n: number; dim: string; style?: CSSProperties }) {
    if (!n) return null
    return (
        <div style={{ color: dim, fontSize: "0.85em", ...style }}>
            <Tooltip title="Mostly local-street crashes before 2018, which NJDOT didn't locate: the police report's road name puts them on this road, but not at a point along it. They count in the totals and plots, and are listed last in the table.">
                <span style={{ borderBottom: `1px dotted ${dim}`, cursor: "help" }}>
                    {n.toLocaleString()} crash{n === 1 ? "" : "es"} located by street name or route only (no map point)
                </span>
            </Tooltip>
        </div>
    )
}

export type RoadCrashTableProps = {
    rows: RoadCrashView[]
    /** Show the SRI column (roads spanning several SRIs). */
    multiSri: boolean
    theme: "light" | "dark"
    /** Sticky-header background (matches the container's). */
    headerBg: string
}

export function RoadCrashTable({ rows, multiSri, theme, headerBg }: RoadCrashTableProps) {
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const cell = { padding: "2px 6px" }
    return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
            <thead>
                <tr style={{ position: "sticky", top: 0, background: headerBg, textAlign: "left" }}>
                    {multiSri && <th style={{ padding: "3px 6px" }}>SRI</th>}
                    <th style={{ padding: "3px 6px" }}>MP</th>
                    <th style={cell}>Date</th>
                    <th style={cell}>Severity</th>
                    <th style={cell}>K/I</th>
                    <th style={cell}>Cross street</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={`${r.id ?? r.case}-${i}`} style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#eee"}` }}>
                        {multiSri && <td style={{ ...cell, color: dim }}>{r.sri?.replace(/_+$/, "") ?? ""}</td>}
                        <td style={cell}>
                            {isUnplaced(r) && r.loc_source ? <UnplacedBadge source={r.loc_source} theme={theme} /> : (r.mp?.toFixed(2) ?? "—")}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                            <Link to={crashHref(r)} style={{ color: fg }}>
                                {new Date(r.dt).toISOString().slice(0, 10)}
                            </Link>
                        </td>
                        <td style={cell}>{SEVERITY[r.severity] ?? r.severity}</td>
                        <td style={cell}>{r.tk ?? 0}/{r.ti ?? 0}</td>
                        <td style={cell}>{r.cross_street ?? ""}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
