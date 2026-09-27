/** A selected road's scope chips (block / stretch / road / corridor), the scope's crash counts
 *  (on this road, and including intersection crashes), and the exclusive / inclusive toggle. Shared
 *  by the map's `RoadPanel` and the road page. */
import type { CSSProperties } from "react"
import { Tooltip } from "@/src/tooltip"
import { corridorOnlyTip } from "./RoadCrashTable"
import { addTotals, SCOPE_LABELS, SCOPE_LEVELS, type ScopeLevel, type Totals } from "./roadScope"
import type { RoadScope } from "./useRoadScope"

export const INCLUSIVE_TIP = (
    <div style={{ fontSize: "1.1em", lineHeight: 1.4 }}>
        <p style={{ margin: "0 0 6px" }}>
            Police file each crash under one road. At an intersection that choice is often arbitrary: the same crash could
            be filed under either street.
        </p>
        <p style={{ margin: "0 0 6px" }}>
            <b>Including intersection crashes</b> (the default) counts crashes at this road&apos;s intersections here even when
            police filed them under the cross street, so they count on both roads.
        </p>
        <p style={{ margin: "0 0 6px" }}>
            <b>On this road</b> counts only crashes filed under this road. These add up across roads with no double counting.
        </p>
        <p style={{ margin: 0 }}>
            &ldquo;At&rdquo; an intersection: police marked it an intersection crash, or put it within 50&nbsp;ft (local
            streets), 75&nbsp;ft (county roads) or 100&nbsp;ft (state highways) of the crossing.
        </p>
    </div>
)

const SCOPE_TIPS: Record<ScopeLevel, string> = {
    block: "One block: between two intersections",
    stretch: "About ½ mile (±¼ mi), in whole blocks",
    road: "The whole road",
    corridor: "The road plus its continuations and parallel carriageways (e.g. East / West, or a highway's two sides)",
}

function fmtTotals(t: Totals): string {
    const parts = [`${t.fatal.toLocaleString()} fatal`, `${t.killed.toLocaleString()} killed`, `${t.injury.toLocaleString()} injury`]
    return parts.join(" · ")
}

export type ScopeBarProps = {
    scope: RoadScope
    /** Map: show the Alt+scroll / shift-click hint. */
    mapHints?: boolean
    theme: "light" | "dark"
    style?: CSSProperties
}

export function ScopeBar({ scope, mapHints, theme, style }: ScopeBarProps) {
    const dim = theme === "dark" ? "#999" : "#666"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const active = theme === "dark" ? "#6db3f2" : "#0066cc"
    const { counts, inclusive, level, custom, available } = scope
    const chip = (on: boolean, enabled: boolean): CSSProperties => ({
        padding: "1px 8px", fontSize: "0.85em", borderRadius: 10, cursor: enabled ? "pointer" : "default",
        border: `1px solid ${on ? active : dim}`, background: on ? active : "transparent", color: on ? "#fff" : enabled ? fg : dim,
        opacity: enabled ? 1 : 0.5,
    })
    const incl = counts ? addTotals(counts.own, counts.xs) : null
    const shown = counts ? (inclusive ? incl! : counts.own) : null
    return (
        <div style={{ fontSize: "0.95em", ...style }}>
            {scope.v5 && (
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginBottom: 3 }}>
                    <span style={{ color: dim, fontSize: "0.85em", marginRight: 2 }}>Scope:</span>
                    {SCOPE_LEVELS.filter(l => l !== "corridor" || scope.state.corridor || available.includes("corridor")).map(l => {
                        const enabled = available.includes(l)
                        const on = l === level && !(custom && l === "stretch")
                        return (
                            <Tooltip key={l} title={SCOPE_TIPS[l]}>
                                <span>
                                    <button
                                        style={chip(on, enabled)}
                                        disabled={!enabled}
                                        aria-pressed={on}
                                        onClick={() => scope.toLevel(l)}
                                    >{SCOPE_LABELS[l]}</button>
                                </span>
                            </Tooltip>
                        )
                    })}
                    {custom && <span style={chip(true, true)}>Span</span>}
                </div>
            )}
            {scope.v5 && (
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ flex: 1 }}>{scope.label}</span>
                    {scope.span && (
                        <button
                            onClick={scope.clear}
                            aria-label="Back to the whole road"
                            style={{ ...chip(false, true), padding: "0 6px" }}
                        >✕</button>
                    )}
                </div>
            )}
            {counts && (
                <div style={{ marginTop: 3 }}>
                    {counts.xs && incl ? (
                        <>
                            <span style={{ fontWeight: inclusive ? 700 : 400 }}>{incl.n.toLocaleString()}</span> crashes incl. intersection crashes
                            {" · "}
                            <span style={{ fontWeight: inclusive ? 400 : 700 }}>{counts.own.n.toLocaleString()}</span> on {scope.state.corridor ? "the corridor" : "this road"}
                            {" "}
                            <Tooltip title={INCLUSIVE_TIP}>
                                <span style={{ color: dim, cursor: "help", border: `1px solid ${dim}`, borderRadius: 8, padding: "0 5px", fontSize: "0.8em" }}>?</span>
                            </Tooltip>
                        </>
                    ) : (
                        <><b>{counts.own.n.toLocaleString()}</b> crashes</>
                    )}
                    {shown && <div style={{ color: dim, fontSize: "0.9em" }}>{fmtTotals(shown)}</div>}
                </div>
            )}
            {counts && scope.corridorOnly > 0 && (
                <div style={{ color: dim, fontSize: "0.85em" }}>
                    <Tooltip title={corridorOnlyTip(scope.corridor?.name)}>
                        <span style={{ borderBottom: `1px dotted ${dim}`, cursor: "help" }}>
                            incl. {scope.corridorOnly.toLocaleString()} located to the {scope.corridor ? `${scope.corridor.name} ` : ""}corridor
                            {" "}(side unknown)
                        </span>
                    </Tooltip>
                </div>
            )}
            {scope.pinnedHere > 0 && (
                <div style={{ color: dim, fontSize: "0.85em" }}>
                    <Tooltip title="Crashes on this road without a map point, whose cross street puts them at or near an intersection here (within the distance police stated). They're listed (“≈ here”), but not in the counts above, which are the crashes located along the road.">
                        <span style={{ borderBottom: `1px dotted ${dim}`, cursor: "help" }}>
                            + {scope.pinnedHere.toLocaleString()} approximately here (no map point; listed, not counted)
                        </span>
                    </Tooltip>
                </div>
            )}
            {scope.crashesLoading && !counts &&<div style={{ color: dim, fontSize: "0.85em" }}>Loading…</div>}
            {scope.crashesError && <div style={{ color: "#d55", fontSize: "0.85em" }}>Error loading crashes: {String(scope.crashesError)}</div>}
            {scope.v5 && (
                <label style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, fontSize: "0.85em", cursor: "pointer" }}>
                    <input type="checkbox" checked={inclusive} onChange={e => scope.setInclusive(e.target.checked)} />
                    Include crashes at its intersections that police filed under the cross street
                </label>
            )}
            {scope.unplacedElsewhere > 0 && (
                <div style={{ color: dim, fontSize: "0.85em" }}>
                    {scope.unplacedElsewhere.toLocaleString()} more on this road without a precise location (not counted here)
                </div>
            )}
            {mapHints && scope.v5 && (
                <div style={{ color: dim, fontSize: "0.8em", marginTop: 2 }}>
                    Alt/⌥+scroll or <kbd>[</kbd> <kbd>]</kbd>: narrower / wider · click the road to move · shift-click: select from there to here
                </div>
            )}
        </div>
    )
}
