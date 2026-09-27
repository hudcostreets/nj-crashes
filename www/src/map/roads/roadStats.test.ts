import { describe, expect, it } from "vitest"
import { monthStats, rollingMean, yearStats } from "./roadStats"

const row = (year: number, severity: string, n: number, tk = 0, ti = 0) => ({ year, severity, n, tk, ti })

describe("yearStats", () => {
    it("sums summary rows by severity, plus killed/injured, per year, zero-filling gaps", () => {
        const rows = [
            row(2020, "f", 1, 1, 2),
            row(2020, "i", 1, 0, 3),
            row(2020, "p", 4),
            row(2022, "p", 2),
            row(2022, "i", 1, 0, 1),
        ]
        expect(yearStats(rows, 2019, 2022)).toEqual({
            years: [2019, 2020, 2021, 2022],
            f: [0, 1, 0, 0],
            i: [0, 1, 0, 1],
            p: [0, 4, 0, 2],
            killed: [0, 1, 0, 0],
            injured: [0, 5, 0, 1],
        })
    })

    it("sums monthly rows into their year", () => {
        const rows = [
            { ...row(2021, "p", 3), month: 1 },
            { ...row(2021, "p", 2), month: 7 },
            { ...row(2021, "f", 1, 2, 0), month: 7 },
        ]
        expect(yearStats(rows, 2021, 2021)).toEqual({
            years: [2021], f: [1], i: [0], p: [5], killed: [2], injured: [0],
        })
    })

    it("widens the range to cover out-of-range years", () => {
        const rows = [row(2024, "i", 1, 0, 2), row(2025, "f", 1, 2, 0)]
        expect(yearStats(rows, 2023, 2024)).toEqual({
            years: [2023, 2024, 2025],
            f: [0, 0, 1],
            i: [0, 1, 0],
            p: [0, 0, 0],
            killed: [0, 0, 2],
            injured: [0, 2, 0],
        })
    })

    it("ignores unknown severities in the per-severity counts", () => {
        expect(yearStats([row(2021, "x", 1, 0, 1)], 2021, 2021)).toEqual({
            years: [2021], f: [0], i: [0], p: [0], killed: [0], injured: [1],
        })
    })
})

describe("monthStats", () => {
    it("zero-fills calendar months over whole years", () => {
        const rows = [
            { year: 2021, month: 1, severity: "p", n: 2 },
            { year: 2021, month: 2, severity: "f", n: 1 },
            { year: 2021, month: 12, severity: "i", n: 3 },
        ]
        expect(monthStats(rows, 2021, 2021)).toEqual({
            months: ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05", "2021-06", "2021-07", "2021-08", "2021-09", "2021-10", "2021-11", "2021-12"],
            f: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            i: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
            p: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        })
    })

    it("widens to the rows' years", () => {
        const s = monthStats([{ year: 2020, month: 12, severity: "p", n: 4 }], 2021, 2021)
        expect([s.months.length, s.months[0], s.months[23], s.p[11]]).toEqual([24, "2020-01", "2021-12", 4])
    })
})

describe("rollingMean", () => {
    it("emits null until a full window, then the trailing mean", () => {
        expect(rollingMean([3, 6, 9, 12, 0], 3)).toEqual([null, null, 6, 9, 7])
    })
})
