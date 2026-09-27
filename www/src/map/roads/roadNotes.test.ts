import { describe, expect, it } from "vitest"
import { matchFilter } from "@/src/lib/pq"
import { bandsAt, formatYears, noteBands, noteFilter, scopeNotes, type RoadNoteRow, type ScopeNote } from "./roadNotes"

const row = (
    entity: number | null,
    corridor: number | null,
    note: string,
    years: [number, number] | null,
    kind = "coverage",
): RoadNoteRow => ({
    entity, corridor, note, kind,
    year_lo: years?.[0] ?? null, year_hi: years?.[1] ?? null,
    title: `${note} title`, text: `${note} text`,
})

// West Side Ave (JC, 42570) has the JC note; the Turnpike (Hudson 42767, Bergen 9476; corridor 2779)
// has two corridor-wide notes; Kearny's West Alignment (1234), in the corridor too, has a muni gap.
const ROWS: RoadNoteRow[] = [
    row(1234, null, "gap-9-5-2011", [2011, 2011]),
    row(1234, null, "turnpike-2012-13", [2012, 2013], "unexplained"),
    row(9476, null, "express-lanes-2023", [2023, 2025], "coding"),
    row(9476, null, "turnpike-2012-13", [2012, 2013], "unexplained"),
    row(42570, null, "jersey-city-pdo-2020", [2020, 2025], "reporting"),
    row(42767, null, "express-lanes-2023", [2023, 2025], "coding"),
    row(42767, null, "turnpike-2012-13", [2012, 2013], "unexplained"),
    row(null, 2656, "express-lanes-2023", [2023, 2025], "coding"),
    row(null, 2779, "express-lanes-2023", [2023, 2025], "coding"),
    row(null, 2779, "turnpike-2012-13", [2012, 2013], "unexplained"),
]

const TURNPIKE = { corridor: 2779, members: [42767, 9476, 1234] }

describe("noteFilter", () => {
    it("selects a road's rows by `entity`", () => {
        expect(noteFilter({ entity: 42570 })).toEqual({ entity: 42570 })
        expect(ROWS.filter(r => matchFilter(r, noteFilter({ entity: 42570 }))).map(r => r.note)).toEqual(["jersey-city-pdo-2020"])
    })

    it("selects a corridor's rows and its members' (sorted, deduped)", () => {
        const f = noteFilter({ corridor: 2779, members: [42767, 9476, 1234, 9476] })
        expect(f).toEqual({ $or: [{ corridor: 2779 }, { entity: { $in: [1234, 9476, 42767] } }] })
        expect(ROWS.filter(r => matchFilter(r, f)).map(r => [r.entity, r.corridor, r.note])).toEqual([
            [1234, null, "gap-9-5-2011"],
            [1234, null, "turnpike-2012-13"],
            [9476, null, "express-lanes-2023"],
            [9476, null, "turnpike-2012-13"],
            [42767, null, "express-lanes-2023"],
            [42767, null, "turnpike-2012-13"],
            [null, 2779, "express-lanes-2023"],
            [null, 2779, "turnpike-2012-13"],
        ])
    })

    it("a corridor without members: its own rows only", () => {
        expect(noteFilter({ corridor: 2779, members: [] })).toEqual({ corridor: 2779 })
    })
})

describe("scopeNotes", () => {
    it("a road: its notes, in year order, lettered", () => {
        expect(scopeNotes(ROWS, { entity: 42767 })).toEqual([
            {
                id: "turnpike-2012-13", kind: "unexplained", title: "turnpike-2012-13 title", text: "turnpike-2012-13 text",
                years: [2012, 2013], label: "A", onCorridor: false, roads: [],
            },
            {
                id: "express-lanes-2023", kind: "coding", title: "express-lanes-2023 title", text: "express-lanes-2023 text",
                years: [2023, 2025], label: "B", onCorridor: false, roads: [],
            },
        ])
    })

    it("a road without notes: none (other roads' and corridors' rows don't apply)", () => {
        expect(scopeNotes(ROWS, { entity: 5 })).toEqual([])
    })

    it("a corridor: one entry per note, on the corridor or only on some members", () => {
        expect(scopeNotes(ROWS, TURNPIKE).map(n => [n.label, n.id, n.onCorridor, n.roads])).toEqual([
            ["A", "gap-9-5-2011", false, [1234]],
            ["B", "turnpike-2012-13", true, [1234, 9476, 42767]],
            ["C", "express-lanes-2023", true, [9476, 42767]],
        ])
    })

    it("all-years notes sort last; one-sided year ranges are one year", () => {
        const rows = [
            row(7, null, "z-always", null),
            { ...row(7, null, "b-2019", null), year_lo: 2019 },
            row(7, null, "a-2010", [2010, 2012]),
        ]
        expect(scopeNotes(rows, { entity: 7 }).map(n => [n.label, n.id, n.years])).toEqual([
            ["A", "a-2010", [2010, 2012]],
            ["B", "b-2019", [2019, 2019]],
            ["C", "z-always", null],
        ])
    })
})

const note = (id: string, years: [number, number] | null, label: string, roads: number[] = [], onCorridor = false): ScopeNote =>
    ({ id, kind: "coverage", title: `${id} title`, text: "", years, label, onCorridor, roads })

describe("noteBands", () => {
    it("clips years to the plot, drops all-years and out-of-range notes", () => {
        const notes = [
            note("port-authority", [1995, 2018], "A"),
            note("jc", [2020, 2027], "B"),
            note("old", [1990, 1999], "C"),
            note("always", null, "D"),
        ]
        expect(noteBands(notes, 2001, 2025)).toEqual([
            { id: "port-authority", label: "A", title: "port-authority title", lo: 2001, hi: 2018 },
            { id: "jc", label: "B", title: "jc title", lo: 2020, hi: 2025 },
        ])
    })

    it("caps the count, keeping corridor-wide then widest notes, in year order", () => {
        const notes = [
            note("g1", [2003, 2003], "A", [1]),
            note("g2", [2006, 2007], "B", [1, 2, 3]),
            note("tp", [2012, 2013], "C", [1, 2, 3, 4], true),
            note("g3", [2015, 2015], "D", [2]),
            note("xl", [2023, 2025], "E", [2, 3], true),
        ]
        expect(noteBands(notes, 2001, 2025, 3).map(b => b.label)).toEqual(["B", "C", "E"])
    })
})

describe("bandsAt / formatYears", () => {
    const bands = [
        { id: "a", label: "A", title: "a", lo: 2010, hi: 2012 },
        { id: "b", label: "B", title: "b", lo: 2012, hi: 2012 },
    ]
    it("bands covering a year", () => {
        expect(bandsAt(bands, 2012).map(b => b.label)).toEqual(["A", "B"])
        expect(bandsAt(bands, 2011).map(b => b.label)).toEqual(["A"])
        expect(bandsAt(bands, 2013)).toEqual([])
    })
    it("year ranges", () => {
        expect([formatYears([2020, 2025]), formatYears([2022, 2022]), formatYears(null)]).toEqual(["2020–2025", "2022", "all years"])
    })
})
