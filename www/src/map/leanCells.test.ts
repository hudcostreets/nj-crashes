import { describe, it, expect } from "vitest"
import { aggregateLean, decodeLean, leanParams, type LeanBody } from "./leanCells"

/** Fake centers so the tests don't depend on S2 geometry. */
const centerOf = (t: string): [number, number] => [t.length, -t.length]

const A = "89c25128e9", B = "89c25128eb", C = "89c257497d"
/** `prefix-hex1` encoding of [A, B, C] (see cells-api `encodeTokens`). */
const ENC = ["0" + A, "9b", "5" + C.slice(5)]

describe("leanParams", () => {
    const years: [number, number] = [2011, 2013]
    const full: [number, number] = [2001, 2025]

    it("group_year: full years + all severities, independent of the filter", () => {
        const p = leanParams(true, years, full, new Set(["f"]))
        expect(p).toEqual({
            labels: "nums", format: "cols", fields: "n_fatal,n_inj_ped,n_inj_other,n_pdo",
            years: "2001-2025", severities: "fip", group: "year",
        })
        expect(leanParams(true, [2020, 2020], full, new Set(["p", "i"]))).toEqual(p)
    })

    it("without group_year: the filter's years + severities (canonical order)", () => {
        expect(leanParams(false, years, full, new Set(["p", "f"]))).toEqual({
            labels: "nums", format: "cols", fields: "n_fatal,n_inj_ped,n_inj_other,n_pdo",
            years: "2011-2013", severities: "fp",
        })
    })
})

const byYear: LeanBody = {
    format: "cols", group: "year", cellid_enc: "prefix-hex1", res: 18, source: "pyramid", n: 3,
    cols: {
        cellid: ENC,
        nyears: [2, 1, 1],
        year: [2011, 2013, 2012, 2020],
        n_fatal: [1, 0, 0, 0],
        n_inj_ped: [0, 0, 1, 0],
        n_inj_other: [0, 1, 0, 0],
        n_pdo: [3, 0, 2, 5],
    },
}

describe("decodeLean", () => {
    it("decodes group=year into offsets + typed columns", () => {
        const t = decodeLean(byYear, centerOf)
        expect({
            res: t.res, byYear: t.byYear, ids: t.ids, centers: [...t.centers], offsets: [...t.offsets],
            year: [...t.year], fatal: [...t.fatal], pedInj: [...t.pedInj], otherInj: [...t.otherInj], pdo: [...t.pdo],
        }).toEqual({
            res: 18, byYear: true, ids: [A, B, C], centers: [10, -10, 10, -10, 10, -10], offsets: [0, 2, 3, 4],
            year: [2011, 2013, 2012, 2020], fatal: [1, 0, 0, 0], pedInj: [0, 0, 1, 0], otherInj: [0, 1, 0, 0], pdo: [3, 0, 2, 5],
        })
    })

    it("decodes a pre-group_year cols body and a legacy rows body identically", () => {
        const cols = decodeLean({
            format: "cols", cellid_enc: "prefix-hex1", res: 17, source: "d1", n: 2,
            cols: { cellid: ENC.slice(0, 2), n_fatal: [1, 0], n_inj_ped: [0, 2], n_inj_other: [0, 0], n_pdo: [4, 0] },
        }, centerOf)
        const rows = decodeLean({
            res: 17, source: "d1",
            cells: [
                { cellid: A, n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 4 },
                { cellid: B, n_fatal: 0, n_inj_ped: 2, n_inj_other: 0, n_pdo: 0 },
            ],
        }, centerOf)
        expect(rows).toEqual(cols)
        expect({ byYear: cols.byYear, offsets: [...cols.offsets], year: [...cols.year] }).toEqual({ byYear: false, offsets: [0, 1, 2], year: [] })
    })

    it("rejects misaligned columns", () => {
        const bad = { ...byYear, cols: { ...byYear.cols, n_pdo: [1] } } as LeanBody
        expect(() => decodeLean(bad, centerOf)).toThrow("cells: 'n_pdo' has 1 rows, expected 4")
    })
})

describe("aggregateLean", () => {
    const t = decodeLean(byYear, centerOf)
    const summary = (cells: ReturnType<typeof aggregateLean>) =>
        cells.map(c => [c.cellid, c.fatal, c.pedInj, c.otherInj, c.pdo, c.total])

    it("sums the selected years", () => {
        expect(summary(aggregateLean(t, [2011, 2013], new Set(["f", "i", "p"])))).toEqual([
            [A, 1, 0, 1, 3, 5],
            [B, 0, 1, 0, 2, 3],
        ])
    })

    it("applies the severity filter and drops emptied cells", () => {
        expect(summary(aggregateLean(t, [2001, 2025], new Set(["i"])))).toEqual([
            [A, 0, 0, 1, 0, 1],
            [B, 0, 1, 0, 0, 1],
        ])
    })

    it("takes a pre-filtered (non-byYear) table as-is", () => {
        const flat = decodeLean({
            format: "cols", cellid_enc: "prefix-hex1", res: 17, source: "d1", n: 1,
            cols: { cellid: ENC.slice(0, 1), n_fatal: [1], n_inj_ped: [0], n_inj_other: [2], n_pdo: [4] },
        }, centerOf)
        expect(summary(aggregateLean(flat, [1990, 1991], new Set(["f"])))).toEqual([[A, 1, 0, 2, 4, 7]])
    })
})
