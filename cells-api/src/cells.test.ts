import { describe, it, expect } from "vitest"
import { parseCellsRequest, HttpError } from "./cells"

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
