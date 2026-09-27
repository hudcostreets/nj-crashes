/** A road's crash table + CSV export, shared by the map's `RoadPanel` and the road page. */
import { useState, type CSSProperties, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useDb } from "@/src/lib/DuckDbContext"
import { Tooltip } from "@/src/tooltip"
import { fetchEntityCrashesFull, isUnplaced, type LocSource, type RoadCrash, type RoadCrashView } from "./roadsData"
import { isPinned } from "./roadScope"

const CSV_COLS: (keyof RoadCrash)[] = [
    "sri", "mp", "dt", "year", "cc", "mc", "case", "severity", "tk", "ti", "pk", "pi", "tv",
    "road", "cross_street", "route", "lat", "lon", "id", "loc_source", "chain", "chain_lo", "chain_hi", "node",
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
export function ExportCsvButton({ entity, slug, v5, disabled, style }: { entity: number; slug: string; v5: boolean; disabled?: boolean; style: CSSProperties }) {
    const db = useDb()
    const [busy, setBusy] = useState(false)
    const onClick = async () => {
        if (!db) return
        setBusy(true)
        try {
            downloadCsv(slug, await fetchEntityCrashesFull(db, entity, v5))
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

const CALIB_TIP = "NJDOT coded this crash to an old route number and milepost that today's road network no longer has (e.g. Hudson's county routes before 2019). Its position was worked out by lining that old route's mileposts up with nearby crashes that do have a location, so it's approximate (usually within a few hundred feet)."

function Badge({ tip, color, dashed = true, children }: { tip: string; color: string; dashed?: boolean; children: ReactNode }) {
    return (
        <Tooltip title={tip}>
            <span style={{
                display: "inline-block", padding: "0 5px", border: `1px ${dashed ? "dashed" : "solid"} ${color}`, borderRadius: 8,
                color, fontSize: "0.85em", whiteSpace: "nowrap", cursor: "help",
            }}>
                {children}
            </span>
        </Tooltip>
    )
}

/** "street name only" badge for crashes on the road without a map point, explained in a tooltip. */
export function UnplacedBadge({ source, theme }: { source: LocSource; theme: "light" | "dark" }) {
    const color = theme === "dark" ? "#bbb" : "#666"
    return (
        <Badge tip={UNPLACED_TIP[source] ?? ""} color={color}>
            {source === "sri_only" ? "route only" : "street name only"}
        </Badge>
    )
}

/** Badge for crashes placed by retired-route calibration (`sri_calib`). */
export function CalibBadge({ theme }: { theme: "light" | "dark" }) {
    return <Badge tip={CALIB_TIP} color={theme === "dark" ? "#9bc" : "#468"}>from old route code</Badge>
}

/** "≈ here": an unplaced crash whose cross street pins it near an intersection in this span. */
function PinnedBadge({ theme }: { theme: "light" | "dark" }) {
    return (
        <Badge tip="The police report doesn't give a map point, but its cross street puts this crash at or near an intersection in this stretch (within the distance police stated)." color={theme === "dark" ? "#bbb" : "#666"}>
            ≈ here
        </Badge>
    )
}

/** "at X": a crash on another road, counted here because it's at an intersection with this one. */
function CrossBadge({ name, theme }: { name: string | null | undefined; theme: "light" | "dark" }) {
    const color = theme === "dark" ? "#e8b86a" : "#9a5b00"
    return (
        <Badge tip={`Police put this crash on ${name ?? "a cross street"}, at its intersection with this road. It's counted on both roads (in "incl. intersection crashes" totals), and once in overall totals.`} color={color} dashed={false}>
            on {name ?? "cross street"}
        </Badge>
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
    rows: (RoadCrashView & { own_name?: string | null })[]
    /** Show the SRI column (roads spanning several SRIs; v4 builds). */
    multiSri: boolean
    /** v5 build: the position column is chain miles along the road ("Mi"), SRI / MP in its tooltip. */
    v5?: boolean
    /** Corridor scope: positions are on each row's own road, so show which road. */
    roadNames?: Map<number, string>
    /** Displayed position (default: `chain`); corridor scope maps it onto the corridor chain. */
    chainOf?: (r: RoadCrashView) => number | null
    theme: "light" | "dark"
    /** Sticky-header background (matches the container's). */
    headerBg: string
}

function srimp(r: RoadCrashView): string {
    return r.sri ? `SRI ${r.sri.replace(/_+$/, "")}${r.mp !== null ? `, MP ${r.mp.toFixed(2)}` : ""}` : "No SRI / milepost"
}

export function RoadCrashTable({ rows, multiSri, v5 = false, roadNames, chainOf, theme, headerBg }: RoadCrashTableProps) {
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const cell = { padding: "2px 6px" }
    const pos = (r: RoadCrashView) => (chainOf ? chainOf(r) : r.chain ?? null)
    const position = (r: RoadCrashView) => {
        // An intersection row (`-xs`) has the intersection's chain even when the crash has no point.
        const hasChain = v5 && r.chain !== null && r.chain !== undefined
        if (isUnplaced(r) && r.loc_source && !isPinned(r) && !hasChain) return <UnplacedBadge source={r.loc_source} theme={theme} />
        if (!v5) return r.mp?.toFixed(2) ?? "—"
        if (isPinned(r)) return <PinnedBadge theme={theme} />
        return (
            <Tooltip title={`${srimp(r)} · ${(pos(r) ?? 0).toFixed(2)} mi along the ${roadNames ? "corridor" : "road"}`}>
                <span style={{ cursor: "help" }}>{pos(r)?.toFixed(2) ?? "—"}</span>
            </Tooltip>
        )
    }
    return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
            <thead>
                <tr style={{ position: "sticky", top: 0, background: headerBg, textAlign: "left", zIndex: 1 }}>
                    {multiSri && !v5 && <th style={{ padding: "3px 6px" }}>SRI</th>}
                    {roadNames && <th style={cell}>Road</th>}
                    <th style={{ padding: "3px 6px" }}>
                        {v5
                            ? <Tooltip title="Miles along the road from its start (south / west end, usually)"><span style={{ cursor: "help" }}>Mi</span></Tooltip>
                            : "MP"}
                    </th>
                    <th style={cell}>Date</th>
                    <th style={cell}>Severity</th>
                    <th style={cell}>K/I</th>
                    <th style={cell}>Cross street</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={`${r.id ?? r.case}-${r.own_entity ?? ""}-${i}`} style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#eee"}` }}>
                        {multiSri && !v5 && <td style={{ ...cell, color: dim }}>{r.sri?.replace(/_+$/, "") ?? ""}</td>}
                        {roadNames && <td style={{ ...cell, color: dim }}>{(r.entity !== undefined && roadNames.get(r.entity)) || ""}</td>}
                        <td style={cell}>{position(r)}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                            <Link to={crashHref(r)} style={{ color: fg }}>
                                {new Date(r.dt).toISOString().slice(0, 10)}
                            </Link>
                        </td>
                        <td style={cell}>{SEVERITY[r.severity] ?? r.severity}</td>
                        <td style={cell}>{r.tk ?? 0}/{r.ti ?? 0}</td>
                        <td style={cell}>
                            {r.own_entity !== null && r.own_entity !== undefined
                                ? <CrossBadge name={r.own_name} theme={theme} />
                                : <>
                                    {r.cross_street ?? ""}
                                    {r.loc_source === "sri_calib" && <> <CalibBadge theme={theme} /></>}
                                </>}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
