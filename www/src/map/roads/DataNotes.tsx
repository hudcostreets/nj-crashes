/** A road's / corridor's "Data notes" (`roadNotes.ts`), for the road page and the map's road panel.
 *  Each note's letter matches its band on the plots / year strip. Renders nothing without notes. */
import type { CSSProperties } from "react"
import { formatYears, kindLabel, type ScopeNote } from "./roadNotes"

type Theme = "light" | "dark"

/** Plot / strip band fill, and the letter badge's (stronger) fill. */
export function noteColors(theme: Theme): { band: string; badge: string; accent: string } {
    return theme === "dark"
        ? { band: "rgba(255, 190, 70, 0.13)", badge: "rgba(255, 190, 70, 0.35)", accent: "rgb(230, 170, 60)" }
        : { band: "rgba(230, 150, 0, 0.11)", badge: "rgba(230, 150, 0, 0.3)", accent: "rgb(210, 140, 0)" }
}

function Badge({ label, theme }: { label: string; theme: Theme }) {
    return (
        <span style={{
            display: "inline-block", minWidth: "1.3em", textAlign: "center", borderRadius: 3, marginRight: 6,
            background: noteColors(theme).badge, fontWeight: 600, fontSize: "0.85em",
        }}>{label}</span>
    )
}

function KindTag({ kind, dim, theme }: { kind: string; dim: string; theme: Theme }) {
    const unexplained = kind === "unexplained"
    const color = unexplained ? (theme === "dark" ? "#f08080" : "#b03030") : dim
    return (
        <span style={{
            marginLeft: 6, padding: "0 5px", border: `1px solid ${color}`, borderRadius: 8, color,
            fontSize: "0.75em", whiteSpace: "nowrap", verticalAlign: "1px",
        }}>{kindLabel(kind)}</span>
    )
}

export type DataNotesProps = {
    notes: ScopeNote[]
    theme: Theme
    /** The map panel: titles only, text on expand. */
    compact?: boolean
    /** Corridor scope: its member count (notes on only some members say so). */
    corridorRoads?: number
    style?: CSSProperties
}

export function DataNotes({ notes, theme, compact, corridorRoads, style }: DataNotesProps) {
    if (!notes.length) return null
    const dim = theme === "dark" ? "#999" : "#666"
    const { accent } = noteColors(theme)
    const scopeOf = (n: ScopeNote) => corridorRoads && !n.onCorridor && n.roads.length
        ? <span style={{ color: dim }}> (on {n.roads.length} of {corridorRoads} roads)</span>
        : null
    const head = (n: ScopeNote) => <>
        <Badge label={n.label} theme={theme} />
        <strong>{n.title}</strong>
        <span style={{ color: dim }}> · {formatYears(n.years)}</span>
        {scopeOf(n)}
        <KindTag kind={n.kind} dim={dim} theme={theme} />
    </>
    return (
        <section data-road-notes aria-label="Data notes" style={{ borderLeft: `3px solid ${accent}`, paddingLeft: 10, ...style }}>
            <div style={{ fontWeight: 600, fontSize: compact ? "0.85em" : "0.95em" }}>
                Data notes{" "}
                <span style={{ fontWeight: "normal", color: dim }}>
                    · {compact
                        ? "changes in the data, not necessarily on the road"
                        : "changes in how crashes were reported or recorded, which can look like a change on the road"}
                </span>
            </div>
            <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, fontSize: compact ? "0.85em" : "0.9em" }}>
                {notes.map(n => (
                    <li key={n.id} id={`note-${n.id}`} style={{ marginBottom: compact ? 2 : 8 }}>
                        {compact
                            ? <details>
                                <summary style={{ cursor: "pointer" }}>{head(n)}</summary>
                                <div style={{ margin: "2px 0 4px 1.3em", color: dim }}>{n.text}</div>
                            </details>
                            : <>
                                <div>{head(n)}</div>
                                <div style={{ marginTop: 2 }}>{n.text}</div>
                            </>}
                    </li>
                ))}
            </ul>
        </section>
    )
}
