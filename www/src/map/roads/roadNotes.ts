/** Data notes (`road-notes.parquet`, specs/road-anomalies.md § Data notes): known changes in how
 *  NJDOT's data covers or codes a road (a town's reports missing some years, an agency reporting
 *  differently, crashes coded to express lanes from 2023, …), shown beside the road's / corridor's
 *  per-year counts so a dip or spike they explain doesn't read as a change on the road.
 *
 *  The file has one row per (road, note) and per (corridor, note): muni-wide notes are already
 *  attached to every road through that muni, and a `corridors: true` note to its corridors and all
 *  their members. It's sorted by `(entity, corridor, note)` (nulls last) with stats on both, so an
 *  `entity` or `corridor` filter reads one or two row groups. */
import type { Filter } from "@/src/lib/pq"

export type NoteKind = "reporting" | "coverage" | "coding" | "unexplained"

export type RoadNoteRow = {
    /** The road (null on a corridor row). */
    entity: number | null
    /** The corridor (null on a road row). */
    corridor: number | null
    /** Note id (`gap-<cc>-<mc>-<y0>[-<y1>]` for automatic coverage gaps). */
    note: string
    kind: string
    /** The years it explains, inclusive (null: all years). */
    year_lo: number | null
    year_hi: number | null
    title: string
    text: string
}

/** What a view shows notes for: a road (whole or a span of it), or a corridor (whole or a span)
 *  with its member roads. */
export type NoteTarget =
    | { entity: number }
    | { corridor: number; members: readonly number[] }

/** A note as shown: one per note id, however many rows the target matched. */
export type ScopeNote = {
    id: string
    kind: string
    title: string
    text: string
    years: [number, number] | null
    /** "A", "B", …: ties a plot band to its entry in the list. */
    label: string
    /** Corridor targets: the note is on the corridor itself (vs only on some of its members). */
    onCorridor: boolean
    /** Corridor targets: the member roads it's on. */
    roads: number[]
}

/** A plot band: a note's years, clipped to the plot's. */
export type NoteBand = { id: string; label: string; title: string; lo: number; hi: number }

export const KIND_LABELS: Record<NoteKind, string> = {
    reporting: "Reporting change",
    coverage: "Missing reports",
    coding: "Coding change",
    unexplained: "Unexplained",
}

export function kindLabel(kind: string): string {
    return KIND_LABELS[kind as NoteKind] ?? kind
}

/** Plot bands at most (the list shows every note). */
export const MAX_BANDS = 4

/** The `readRows` filter for a target's rows. */
export function noteFilter(t: NoteTarget): Filter {
    if ("entity" in t) return { entity: t.entity | 0 }
    const members = [...new Set(t.members.map(m => m | 0))].sort((a, b) => a - b)
    return members.length
        ? { $or: [{ corridor: t.corridor | 0 }, { entity: { $in: members } }] }
        : { corridor: t.corridor | 0 }
}

/** Whether a row is about the target. */
export function rowMatches(r: RoadNoteRow, t: NoteTarget): boolean {
    if ("entity" in t) return r.entity === t.entity
    return r.corridor === t.corridor || (r.entity !== null && t.members.includes(r.entity))
}

function label(k: number): string {
    return k < 26 ? String.fromCharCode(65 + k) : `${String.fromCharCode(65 + Math.floor(k / 26) - 1)}${String.fromCharCode(65 + (k % 26))}`
}

/** A target's notes, one per id, in year order (all-years notes last, then by id), labeled A, B, … */
export function scopeNotes(rows: readonly RoadNoteRow[], t: NoteTarget): ScopeNote[] {
    const byId = new Map<string, Omit<ScopeNote, "label">>()
    for (const r of rows) {
        if (!rowMatches(r, t)) continue
        let n = byId.get(r.note)
        if (!n) {
            const years: [number, number] | null = r.year_lo === null && r.year_hi === null
                ? null
                : [r.year_lo ?? r.year_hi!, r.year_hi ?? r.year_lo!]
            n = { id: r.note, kind: r.kind, title: r.title, text: r.text, years, onCorridor: false, roads: [] }
            byId.set(r.note, n)
        }
        if ("corridor" in t && r.corridor === t.corridor) n.onCorridor = true
        if ("corridor" in t && r.entity !== null && !n.roads.includes(r.entity)) n.roads.push(r.entity)
    }
    const notes = [...byId.values()]
    for (const n of notes) n.roads.sort((a, b) => a - b)
    notes.sort((a, b) =>
        (a.years === null ? 1 : 0) - (b.years === null ? 1 : 0)
        || (a.years && b.years ? a.years[0] - b.years[0] || a.years[1] - b.years[1] : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return notes.map((n, k) => ({ ...n, label: label(k) }))
}

/** Plot bands for `notes` over `[y0, y1]`: notes with years overlapping the plot, clipped to it;
 *  at most `max`, preferring (on a corridor) notes on the corridor itself, then on more of its
 *  roads, then earlier. In year order. */
export function noteBands(notes: readonly ScopeNote[], y0: number, y1: number, max = MAX_BANDS): NoteBand[] {
    const idx = new Map(notes.map((n, k) => [n.id, k]))
    return notes
        .filter((n): n is ScopeNote & { years: [number, number] } => !!n.years && n.years[1] >= y0 && n.years[0] <= y1)
        .sort((a, b) => Number(b.onCorridor) - Number(a.onCorridor) || b.roads.length - a.roads.length || idx.get(a.id)! - idx.get(b.id)!)
        .slice(0, max)
        .sort((a, b) => idx.get(a.id)! - idx.get(b.id)!)
        .map(n => ({ id: n.id, label: n.label, title: n.title, lo: Math.max(y0, n.years[0]), hi: Math.min(y1, n.years[1]) }))
}

/** The bands covering `year`. */
export function bandsAt(bands: readonly NoteBand[], year: number): NoteBand[] {
    return bands.filter(b => b.lo <= year && year <= b.hi)
}

/** "2020–2025", "2022", or "all years". */
export function formatYears(years: [number, number] | null): string {
    if (!years) return "all years"
    return years[0] === years[1] ? `${years[0]}` : `${years[0]}–${years[1]}`
}
