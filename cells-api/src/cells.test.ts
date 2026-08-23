import { describe, it, expect } from "vitest"
import { S2CellId, S2LatLng } from "nodes2ts"
import { parseCellsRequest, HttpError, coarsenCellsS2, servedLabels, DEFAULT_LABEL_MAX_CELLS } from "./cells"

/** Minimal valid query — only the two required params. `cells` is an S2
 *  token (NJ's western l4 shard); `res` is an S2 level. */
const BASE = "cells=89b&res=12"

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

describe("coarsenCellsS2", () => {
    /** (lat, lng) → S2 token at `level`. */
    const tok = (lat: number, lng: number, level: number) =>
        S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint()).parentL(level).toToken()

    // Two distinct l14 cells far enough apart that their l13 parents differ,
    // plus a sibling of the first (any other l14 under the same l13).
    const jc = tok(40.7178, -74.0431, 14)      // Jersey City
    const newark = tok(40.7357, -74.1724, 14)  // Newark
    const jcParent = tok(40.7178, -74.0431, 13)
    const newarkParent = tok(40.7357, -74.1724, 13)
    // ~700 m SW: a *different* l14 cell (edge ≈ 478 m)
    // under the *same* l13 parent. Asserted below rather than assumed —
    // the whole test rests on it.
    const jcSib = tok(40.7153, -74.0506, 14)

    it("picks l14 cells that do / don't share an l13 parent", () => {
        expect({
            distinctChildren: jc !== jcSib,
            sameParent: tok(40.7153, -74.0506, 13) === jcParent,
            newarkElsewhere: jcParent !== newarkParent,
        }).toEqual({ distinctChildren: true, sameParent: true, newarkElsewhere: true })
    })

    it("sums counts across children mapping to the same parent", () => {
        const a = { h3: jc, n_fatal: 1, n_inj_ped: 2, n_inj_other: 3, n_pdo: 4, n_vehs: 5 }
        const b = { h3: jcSib, n_fatal: 10, n_inj_ped: 20, n_inj_other: 30, n_pdo: 40, n_vehs: 50 }
        const c = { h3: newark, n_fatal: 7, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 1 }
        const out = coarsenCellsS2([a, b, c], 13)
        expect(out).toEqual([
            { h3: jcParent, n_fatal: 11, n_inj_ped: 22, n_inj_other: 33, n_pdo: 44, n_vehs: 55 },
            { h3: newarkParent, n_fatal: 7, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 1 },
        ])
    })

    it("returns empty for empty input", () => {
        expect(coarsenCellsS2([], 13)).toEqual([])
    })

    it("aggregates fatal_years across children, dedup+sort", () => {
        const a = { h3: jc, n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, fatal_years: [2018, 2020] }
        const b = { h3: jcSib, n_fatal: 1, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0, fatal_years: [2020, 2022] }
        expect(coarsenCellsS2([a, b], 13)).toEqual([
            {
                h3: jcParent, n_fatal: 2, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0,
                fatal_years: [2018, 2020, 2022],
            },
        ])
    })
})

describe("parseCellsRequest grid param", () => {
    it("accepts an explicit `grid=s2`", () => {
        expect(parse(`${BASE}&grid=s2`).cells).toEqual(["89b"])
    })

    it("rejects `grid=h3` with a 400 rather than serving S2 tokens to it", () => {
        let err: HttpError | undefined
        try { parse(`${BASE}&grid=h3`) } catch (e) { err = e as HttpError }
        expect(err).toBeInstanceOf(HttpError)
        expect(err?.status).toBe(400)
        expect(err?.message).toBe("grid 'h3' is no longer supported — s2 is the only grid")
    })

    it("cannot reject a 15-char H3 id by shape — it parses as a token", () => {
        // Documented, not desired: an H3 id is 15 lowercase hex chars, which
        // the S2 token regex (1-16 hex) admits. It dies downstream instead —
        // `s2LevelOf` reads it as a level-28 cell, and `handleCellsRequest`
        // 400s on a shard finer than the requested level.
        expect(parse("cells=8c2a100894097ff&res=12").cells).toEqual(["8c2a100894097ff"])
    })

    it("accepts `X` (cell id 0) and rejects a non-hex token", () => {
        expect(parse("cells=X&res=12").cells).toEqual(["X"])
        expect(() => parse("cells=zz&res=12")).toThrow(HttpError)
    })

    it("bounds `shard_res` by the S2 level range, not H3's 15", () => {
        expect(parse(`${BASE}&shard_res=21`).shardRes).toBe(21)
        expect(() => parse(`${BASE}&shard_res=22`)).toThrow(HttpError)
        expect(() => parse(`${BASE}&shard_res=3`)).toThrow(HttpError)
    })
})

describe("label capping", () => {
    const cell = (i: number) => ({
        h3: `89c${i}`, n_fatal: 0, n_inj_ped: 0, n_inj_other: 1, n_pdo: 2, n_vehs: 3,
        sld_name: "JOHN F KENNEDY BLVD", cross_sld_name: "SIP AVE",
        mun: "Jersey City", county: "Hudson",
    })
    const cells = (n: number) => Array.from({ length: n }, (_, i) => cell(i))

    it("serves `full` under the cap, leaving labels intact", () => {
        const cs = cells(3)
        expect(servedLabels("full", cs, 10)).toBe("full")
        expect(cs[0]).toEqual({
            h3: "89c0", n_fatal: 0, n_inj_ped: 0, n_inj_other: 1, n_pdo: 2, n_vehs: 3,
            sld_name: "JOHN F KENNEDY BLVD", cross_sld_name: "SIP AVE",
            mun: "Jersey City", county: "Hudson",
        })
    })

    it("degrades `full` to `nums` over the cap, dropping only the 4 strings", () => {
        const cs = cells(3)
        expect(servedLabels("full", cs, 2)).toBe("nums")
        expect(cs.map(c => Object.keys(c))).toEqual([
            ["h3", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
            ["h3", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
            ["h3", "n_fatal", "n_inj_ped", "n_inj_other", "n_pdo", "n_vehs"],
        ])
        expect(cs[0]).toEqual({ h3: "89c0", n_fatal: 0, n_inj_ped: 0, n_inj_other: 1, n_pdo: 2, n_vehs: 3 })
    })

    it("leaves an explicit `nums`/`only` request alone", () => {
        expect(servedLabels("nums", cells(50), 2)).toBe("nums")
        expect(servedLabels("only", cells(50), 2)).toBe("only")
    })

    it("defaults the cap to DEFAULT_LABEL_MAX_CELLS", () => {
        expect(servedLabels("full", cells(3))).toBe("full")
        expect(DEFAULT_LABEL_MAX_CELLS).toBe(20_000)
    })

    it("parses `label_max_cells`", () => {
        expect(parse(`${BASE}&label_max_cells=5000`).labelMaxCells).toBe(5000)
        expect(parse(BASE).labelMaxCells).toBe(undefined)
        expect(() => parse(`${BASE}&label_max_cells=-1`)).toThrow(HttpError)
    })
})
