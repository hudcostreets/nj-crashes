import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchEntity, peekEntity, type RoadPoint } from "./roadsData"

/** Wait this long on one road before fetching its summary, so sweeping the cursor across a
 *  street grid doesn't fire a ranged read per road crossed. */
const INFO_DELAY_MS = 150

function useSettled<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setSettled(value), ms)
        return () => clearTimeout(t)
    }, [value, ms])
    return settled
}

export type HoverDrawerProps = {
    /** Road under the cursor (null if none). */
    road: RoadPoint | null
    /** Whether that road is the current selection. */
    roadSelected: boolean
    /** Label of the muni / county under the cursor, when clicking it opens it. */
    area: string | null
    /** Pushed right when the selected-road panel occupies the bottom-left. */
    dodgePanel: boolean
    /** The selected road's scope, when it has scopes (v5): its label ("Block: Fulton Avenue to
     *  Stegman Parkway, 0.07 mi"), and whether a sub-road span is active. */
    scope?: { label: string; span: boolean; corridor: boolean } | null
    theme: "light" | "dark"
}

/** What's under the cursor: the road (with its crash summary) and the muni / county, which are
 *  independent of each other; a click goes to the road when there is one, else the area. With a
 *  scoped road selected, also the scope and how to change it. */
export function HoverDrawer({ road, roadSelected, area, dodgePanel, scope, theme }: HoverDrawerProps) {
    // A road whose row group is already in memory shows its summary at once; others wait for
    // the cursor to settle before reading (which caches the road's whole group).
    const cached = road ? peekEntity(road.entity) : undefined
    const entity = useSettled(road && !cached ? road.entity : null, INFO_DELAY_MS)
    const info = useQuery({
        queryKey: ["road-entity", entity],
        queryFn: () => fetchEntity(entity!),
        enabled: entity !== null,
    })
    if (!road && !area) return null
    const summary = cached ?? (road && info.data?.entity === road.entity ? info.data : null)
    const dim = theme === "dark" ? "#999" : "#666"
    const action = road
        ? (roadSelected
            ? (scope ? "click: move the scope here · shift-click: select from the marker to here" : "selected")
            : `click: select ${road.name}`)
        : `click: open ${area}`
    return (
        <div style={{
            position: "absolute", bottom: 12, zIndex: 3, pointerEvents: "none",
            ...(dodgePanel ? { right: 12 } : { left: "50%", transform: "translateX(-50%)" }),
            minWidth: 220, maxWidth: 360, padding: "6px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.4,
            background: theme === "dark" ? "rgba(30,30,30,0.92)" : "rgba(255,255,255,0.94)",
            color: theme === "dark" ? "#e0e0e0" : "#333",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
        }}>
            {road && (
                <div>
                    <strong>{road.name}</strong>
                    {road.alias && <span style={{ color: dim }}> · {road.alias}</span>}
                    {summary?.route && <div style={{ color: dim }}>on {summary.route}</div>}
                    {summary && (
                        <div>
                            {summary.n_crashes.toLocaleString()} crashes · {summary.n_killed.toLocaleString()} killed
                            {" · "}{summary.n_injury.toLocaleString()} injury
                        </div>
                    )}
                </div>
            )}
            {area && (
                <div style={road ? { marginTop: 4, paddingTop: 4, borderTop: `1px solid ${dim}` } : undefined}>
                    {area}
                </div>
            )}
            <div style={{ color: dim, marginTop: 2 }}>{action}</div>
            {scope && (
                <div style={{ marginTop: 4, paddingTop: 4, borderTop: `1px solid ${dim}` }}>
                    <div>Showing: {scope.label}</div>
                    <div style={{ color: dim }}>
                        Alt/⌥+scroll or [ ]: {scope.corridor ? "road → corridor" : "block ↔ stretch ↔ road ↔ corridor"}
                        {scope.span && " · drag the white ends to adjust"}
                    </div>
                </div>
            )}
        </div>
    )
}
