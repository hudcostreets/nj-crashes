import { describe, expect, it } from "vitest"

import { pickYearlyRows } from "./yearlyRows"

type Row = { year: number, total: number }

const MONTHLY: Row[] = [{ year: 2024, total: 2 }, { year: 2025, total: 1 }]
const YTC: Row[] = [{ year: 2024, total: 45 }, { year: 2025, total: 43 }]

describe("pickYearlyRows", () => {
    it("prefers monthly rows over the ytc fallback", () => {
        expect(pickYearlyRows(MONTHLY, YTC, null)).toEqual(MONTHLY)
        expect(pickYearlyRows(MONTHLY, YTC, 22)).toEqual(MONTHLY)
    })

    it("falls back to ytc statewide/county, where ytc is the right grain", () => {
        expect(pickYearlyRows([], YTC, null)).toEqual(YTC)
    })

    it("returns empty for a muni with no monthly rows, rather than its county's totals", () => {
        // `ytc` (`year-type-county.parquet`) is county-grained, so the fallback
        // would attribute Burlington County's fatalities to Delanco (cc=3, mc=9),
        // which had none until 2026-08-12.
        expect(pickYearlyRows([], YTC, 9)).toEqual([])
    })

    it("treats mc=0 as a municipality, not as absent", () => {
        expect(pickYearlyRows([], YTC, 0)).toEqual([])
    })
})

describe("pickYearlyRows referential stability", () => {
    // A fresh `[]` per call invalidates the plot's `useMemo` chain every
    // render, which froze the tab on a zero-fatal muni.
    it("returns the same empty array instance across calls", () => {
        expect(pickYearlyRows([], YTC, 9)).toBe(pickYearlyRows([], YTC, 22))
    })

    it("passes through the caller's arrays by identity, not by copy", () => {
        expect(pickYearlyRows(MONTHLY, YTC, 9)).toBe(MONTHLY)
        expect(pickYearlyRows([], YTC, null)).toBe(YTC)
    })
})
