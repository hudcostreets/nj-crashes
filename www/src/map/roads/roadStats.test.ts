import { describe, expect, it } from "vitest"
import { monthStats, rollingMean, yearStats } from "./roadStats"

const crash = (year: number, severity: string, tk = 0, ti = 0) => ({ year, severity, tk, ti })

describe("yearStats", () => {
    it("counts crashes by severity and sums killed/injured per year, zero-filling gaps", () => {
        const crashes = [
            crash(2020, "f", 1, 2),
            crash(2020, "i", 0, 3),
            crash(2020, "p"),
            crash(2022, "p"),
            crash(2022, "i", 0, 1),
        ]
        expect(yearStats(crashes, 2019, 2022)).toEqual({
            years: [2019, 2020, 2021, 2022],
            f: [0, 1, 0, 0],
            i: [0, 1, 0, 1],
            p: [0, 1, 0, 1],
            killed: [0, 1, 0, 0],
            injured: [0, 5, 0, 1],
        })
    })

    it("widens the range to cover out-of-range years, and treats null tk/ti as 0", () => {
        const crashes = [
            { year: 2024, severity: "i", tk: null, ti: null },
            { year: 2025, severity: "f", tk: 2, ti: null },
        ]
        expect(yearStats(crashes, 2023, 2024)).toEqual({
            years: [2023, 2024, 2025],
            f: [0, 0, 1],
            i: [0, 1, 0],
            p: [0, 0, 0],
            killed: [0, 0, 2],
            injured: [0, 0, 0],
        })
    })

    it("ignores unknown severities in the per-severity counts", () => {
        expect(yearStats([crash(2021, "x", 0, 1)], 2021, 2021)).toEqual({
            years: [2021], f: [0], i: [0], p: [0], killed: [0], injured: [1],
        })
    })
})

describe("monthStats", () => {
    it("buckets by UTC calendar month over whole years", () => {
        const crashes = [
            { dt: Date.UTC(2021, 0, 31, 23, 59), severity: "p" },
            { dt: Date.UTC(2021, 1, 1, 0, 0), severity: "f" },
            { dt: Date.UTC(2021, 11, 15), severity: "i" },
        ]
        const s = monthStats(crashes, 2021, 2021)
        expect(s).toEqual({
            months: ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05", "2021-06", "2021-07", "2021-08", "2021-09", "2021-10", "2021-11", "2021-12"],
            f: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            i: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            p: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        })
    })

    it("widens to the crashes' years", () => {
        const s = monthStats([{ dt: Date.UTC(2020, 11, 1), severity: "p" }], 2021, 2021)
        expect([s.months.length, s.months[0], s.months[23], s.p[11]]).toEqual([24, "2020-01", "2021-12", 1])
    })
})

describe("rollingMean", () => {
    it("emits null until a full window, then the trailing mean", () => {
        expect(rollingMean([3, 6, 9, 12, 0], 3)).toEqual([null, null, 6, 9, 7])
    })
})
