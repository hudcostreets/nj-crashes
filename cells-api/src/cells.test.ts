import { describe, it, expect } from "vitest"
import { latLngToCell, cellToParent } from "h3-js"
import { parseCellsRequest, HttpError, coarsenCells } from "./cells"

/** Minimal valid query — only the two required params. */
const BASE = "cells=8c2a100894097ff&res=12"

function parse(qs: string) {
    return parseCellsRequest(new URL(`https://x/?${qs}`))
}

describe("parseCellsRequest severity param", () => {
    it("accepts `severities=fi` (plural — historical client form)", () => {
        const r = parse(`${BASE}&severities=fi`)
        expect(r.severities && [...r.severities].sort()).toEqual(["f", "i"])
    })

    it("accepts `severity=fi` (singular — fixes silent-ignore bug)", () => {
        const r = parse(`${BASE}&severity=fi`)
        expect(r.severities && [...r.severities].sort()).toEqual(["f", "i"])
    })

    it("returns undefined severities when neither param is set", () => {
        const r = parse(BASE)
        expect(r.severities).toBeUndefined()
    })

    it("rejects unknown severity char with 400", () => {
        let err: HttpError | undefined
        try { parse(`${BASE}&severity=fx`) } catch (e) { err = e as HttpError }
        expect(err).toBeInstanceOf(HttpError)
        expect(err?.status).toBe(400)
        expect(err?.message).toContain("unknown severity")
    })

    it("singular `severity` wins when both are set", () => {
        // Defensive: defines tie-break behavior so a future caller that sets
        // both doesn't silently drop one. Singular is the canonical form.
        const r = parse(`${BASE}&severities=p&severity=fi`)
        expect(r.severities && [...r.severities].sort()).toEqual(["f", "i"])
    })

    it("accepts all three: severity=fip", () => {
        const r = parse(`${BASE}&severity=fip`)
        expect(r.severities && [...r.severities].sort()).toEqual(["f", "i", "p"])
    })
})

describe("parseCellsRequest labels param", () => {
    it("defaults to undefined (handler treats as full)", () => {
        expect(parse(BASE).labels).toBeUndefined()
    })

    it.each(["full", "nums", "only"] as const)("accepts labels=%s", v => {
        expect(parse(`${BASE}&labels=${v}`).labels).toBe(v)
    })

    it("rejects an unknown labels value with 400", () => {
        let err: HttpError | undefined
        try { parse(`${BASE}&labels=strings`) } catch (e) { err = e as HttpError }
        expect(err).toBeInstanceOf(HttpError)
        expect(err?.status).toBe(400)
        expect(err?.message).toBe("labels must be one of full|nums|only")
    })
})

describe("coarsenCells", () => {
    // Two distinct r10 cells from geographically-separated lat/lngs so
    // their r9 parents differ; plus a synthetic sibling of the first
    // (any other r10 whose r9 parent matches).
    const jcR10 = latLngToCell(40.7178, -74.0431, 10)      // Jersey City
    const newarkR10 = latLngToCell(40.7357, -74.1724, 10)  // Newark
    const jcParent = cellToParent(jcR10, 9)
    const newarkParent = cellToParent(newarkR10, 9)
    // sibling of jcR10 (drop resolution and re-index at r10 by nudging lat).
    // The specific sibling doesn't matter — we just need same r9 parent.
    const jcSib = latLngToCell(40.7180, -74.0429, 10)

    it("sums counts across children mapping to the same parent", () => {
        const a = { h3: jcR10, n_fatal: 1, n_inj_ped: 2, n_inj_other: 3, n_pdo: 4, n_vehs: 5 }
        const b = { h3: jcSib, n_fatal: 10, n_inj_ped: 20, n_inj_other: 30, n_pdo: 40, n_vehs: 50 }
        const c = { h3: newarkR10, n_fatal: 7, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 1 }
        const out = coarsenCells([a, b, c], 9)
        // Two distinct parents: jcParent (has a+b) and newarkParent (has c).
        expect(out.length).toBe(2)
        expect(new Set(out.map(o => o.h3))).toEqual(new Set([jcParent, newarkParent]))
        const jc = out.find(o => o.h3 === jcParent)!
        const nw = out.find(o => o.h3 === newarkParent)!
        expect(jc.n_fatal).toBe(1 + 10)
        expect(jc.n_inj_other).toBe(3 + 30)
        expect(jc.n_pdo).toBe(4 + 40)
        expect(nw.n_fatal).toBe(7)
        expect(nw.n_vehs).toBe(1)
    })

    it("returns empty for empty input", () => {
        expect(coarsenCells([], 9)).toEqual([])
    })

    it("aggregates fatal_years across children, dedup+sort", () => {
        const a = { h3: jcR10, n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, fatal_years: [2018, 2020] }
        const b = { h3: jcSib, n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, fatal_years: [2020, 2022] }
        const [parent] = coarsenCells([a, b], 9)
        expect(parent.h3).toBe(jcParent)
        expect(parent.fatal_years).toEqual([2018, 2020, 2022])
    })
})
