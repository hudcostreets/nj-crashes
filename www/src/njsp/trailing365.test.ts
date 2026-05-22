import { describe, expect, it } from "vitest"
import { TRAILING_WINDOW, trailing365Series, ymd } from "./trailing365"

// Fixed "now" so the windowing is deterministic: May 21, 2026.
const NOW = new Date(2026, 4, 21)

describe("ymd", () => {
    it("formats local-time Y-M-D, zero-padded", () => {
        expect(ymd(new Date(2026, 0, 3))).toBe("2026-01-03")
        expect(ymd(new Date(2025, 11, 31))).toBe("2025-12-31")
    })
})

describe("trailing365Series", () => {
    it("builds a 365-date window ending on now's date", () => {
        const { xDates } = trailing365Series([{ year: 2026, day_of_year: 1, fatalities: 0 }], NOW)
        expect(xDates.length).toBe(TRAILING_WINDOW)
        expect(xDates[0]).toBe("2025-05-22")
        expect(xDates[TRAILING_WINDOW - 1]).toBe("2026-05-21")
    })

    it("emits one window-year per year after the first (each needs a prior-year tail)", () => {
        const rows = [
            { year: 2024, day_of_year: 100, fatalities: 1 },
            { year: 2025, day_of_year: 100, fatalities: 1 },
            { year: 2026, day_of_year: 100, fatalities: 1 },
        ]
        expect(trailing365Series(rows, NOW).series.map(s => s.year)).toEqual([2025, 2026])
    })

    it("cumulates daily fatalities across the year boundary", () => {
        // Dec 16 2025 (prior-year tail) + Jan 1 2026 (this-year head), both
        // inside window-year 2026's May'25 -> May'26 window.
        const rows = [
            { year: 2025, day_of_year: 350, fatalities: 3 },  // Dec 16 2025
            { year: 2026, day_of_year: 1, fatalities: 2 },     // Jan 1 2026
        ]
        const w2026 = trailing365Series(rows, NOW).series.find(s => s.year === 2026)!
        expect(w2026.cumulative[0]).toBe(0)
        expect(w2026.cumulative[TRAILING_WINDOW - 1]).toBe(5)
        // The daily delta lands on Jan 1 and Dec 16 only.
        expect(w2026.daily.filter(d => d > 0)).toEqual([3, 2])
    })

    it("excludes crashes outside the trailing window", () => {
        // May 1 2025 predates window-year 2026's start (May 22 2025).
        const rows = [{ year: 2025, day_of_year: 121, fatalities: 9 }]
        const w2026 = trailing365Series(rows, NOW).series.find(s => s.year === 2026)!
        expect(w2026.cumulative[TRAILING_WINDOW - 1]).toBe(0)
    })
})
