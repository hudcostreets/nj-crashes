import { describe, it, expect } from "vitest"
import { BY_YEAR_FIELDS, N_BY_YEAR, forEachYear, sumByYear } from "./by-year"

/** Same literal as `tests/test_cells_years.py`'s `ENCODED` (the Python
 *  encoder's output), so the two sides can't drift apart silently. */
const ENCODED = "13:3,1,2,1;19:1,,,,1,1,1"

function entries(enc: string): Array<[number, number[]]> {
    const out: Array<[number, number[]]> = []
    forEachYear(enc, (y, c) => out.push([y, [...c]]))
    return out
}

describe("forEachYear", () => {
    it("decodes entries in order, empty and trailing counts as 0", () => {
        expect(BY_YEAR_FIELDS).toEqual(["n_vehs", "n_pdo", "n_inj_other", "n_inj_ped", "n_fatal", "n_killed", "n_killed_ped"])
        expect(entries(ENCODED)).toEqual([
            [2013, [3, 1, 2, 1, 0, 0, 0]],
            [2019, [1, 0, 0, 0, 1, 1, 1]],
        ])
    })

    it("handles an all-zero entry, multi-digit counts, and a last-field-only entry", () => {
        expect(entries("1:;10:12,10;25:,,,,,,2")).toEqual([
            [2001, [0, 0, 0, 0, 0, 0, 0]],
            [2010, [12, 10, 0, 0, 0, 0, 0]],
            [2025, [0, 0, 0, 0, 0, 0, 2]],
        ])
        expect(entries("")).toEqual([])
    })

    it("rejects malformed input", () => {
        for (const bad of ["13", ":1", "13:1;", "13:1,,,,,,,1", "13:x", "13:1;;14:1"]) {
            expect(() => entries(bad), bad).toThrow(`malformed by_year at`)
        }
    })
})

describe("sumByYear", () => {
    const out = new Int32Array(N_BY_YEAR)
    const ENC = "5:1;13:3,1,2,1;19:1,,,,1,1,1;21:2,,,,1,2"

    it("sums the inclusive range and lists its fatal years", () => {
        expect([sumByYear(ENC, 2001, 2025, out), [...out]]).toEqual([[2019, 2021], [7, 1, 2, 1, 2, 3, 1]])
        expect([sumByYear(ENC, 2013, 2019, out), [...out]]).toEqual([[2019], [4, 1, 2, 1, 1, 1, 1]])
        expect([sumByYear(ENC, 2020, 2021, out), [...out]]).toEqual([[2021], [2, 0, 0, 0, 1, 2, 0]])
    })

    it("zeroes the output for a range with no entries", () => {
        expect([sumByYear(ENC, 2006, 2012, out), [...out]]).toEqual([[], [0, 0, 0, 0, 0, 0, 0]])
    })
})
