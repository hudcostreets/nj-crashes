import { describe, expect, it } from "vitest"
import type { CC2MC2MN } from "@/src/county"
import { formatRoadHit, matchesAll, queryTokens, roadLocation, tokenPatterns, type RoadHit } from "./roadSearch"

const CC2MC2MN: CC2MC2MN = {
    7: { cn: "Essex", mc2mn: { 2: "Bloomfield", 5: "East Orange", 14: "Newark" } },
    9: { cn: "Hudson", mc2mn: { 6: "Jersey City", 8: "North Bergen" } },
}

describe("queryTokens", () => {
    it("lower-cases and splits on anything non-alphanumeric (quotes, LIKE / regex syntax)", () => {
        expect(queryTokens(`  West-Side 'ave'%_ (.*) `)).toEqual(["west", "side", "ave"])
        expect(queryTokens(`'; DROP TABLE road_search; --`)).toEqual(["drop", "table", "road", "search"])
        expect(queryTokens("%_")).toEqual([])
    })
})

describe("tokenPatterns", () => {
    it("matches typed tokens as word prefixes, synonyms as whole words", () => {
        expect(tokenPatterns("west side")).toEqual([
            "(^|[^a-z0-9])(west|(w)([^a-z0-9]|$))",
            "(^|[^a-z0-9])side",
        ])
        expect(tokenPatterns("Ave")).toEqual(["(^|[^a-z0-9])(ave|(avenue|av)([^a-z0-9]|$))"])
        expect(tokenPatterns("st")).toEqual(["(^|[^a-z0-9])(st|(street|saint)([^a-z0-9]|$))"])
    })
})

describe("matchesAll", () => {
    const hits = (query: string, names: string[]) => names.filter(n => matchesAll(n, tokenPatterns(query)))
    it("expands abbreviations both ways, at word boundaries", () => {
        const names = ["W Side Ave", "WEST SIDE AVE", "Westside Ave", "Walnut St", "Side St W", "Hillside Ave"]
        expect(hits("west side", names)).toEqual(["W Side Ave", "WEST SIDE AVE", "Side St W"])
        expect(hits("w side avenue", names)).toEqual(["W Side Ave", "WEST SIDE AVE"])
        expect(hits("tonnel", ["Tonnelle Ave", "TONNELE AVE", "Van Reypen St"])).toEqual(["Tonnelle Ave", "TONNELE AVE"])
    })
})

describe("roadLocation", () => {
    it("reads county / muni from SRIs", () => {
        expect(roadLocation("09061575__,09061684__", CC2MC2MN)).toEqual("Jersey City, Hudson")
        expect(roadLocation("07021685__,07051353__", CC2MC2MN)).toEqual("Bloomfield / East Orange, Essex")
        expect(roadLocation("07021685__,07051353__,07141000__", CC2MC2MN)).toEqual("Essex County")
        expect(roadLocation("09001234__,09061575__", CC2MC2MN)).toEqual("Hudson County")
        expect(roadLocation("07141000__,09061575__", CC2MC2MN)).toEqual("Essex / Hudson")
    })
    it("gives no location for statewide routes, unknown codes, or before the lookup loads", () => {
        expect(roadLocation("00000501__", CC2MC2MN)).toEqual(null)
        expect(roadLocation("00000001_S,09061575__", CC2MC2MN)).toEqual(null)
        expect(roadLocation("21011000__", CC2MC2MN)).toEqual(null)
        expect(roadLocation("09061575__", null)).toEqual(null)
    })
})

describe("formatRoadHit", () => {
    const hit = (h: Partial<RoadHit>): RoadHit => ({
        entity: 1, name: "", route: null, subt: 7, aliases: null, sris: "09061575__", n_crashes: 1, ...h,
    })
    it("shows the alias that matched when the name didn't", () => {
        expect(formatRoadHit(hit({ name: "ROUTE 501", aliases: "KENNEDY BLVD", sris: "00000501__", n_crashes: 26799 }), "kennedy", CC2MC2MN)).toEqual({
            label: "ROUTE 501",
            alias: "KENNEDY BLVD",
            description: "aka KENNEDY BLVD · 26,799 crashes",
        })
        expect(formatRoadHit(hit({ name: "Duncan Ave", route: "WEST SIDE AVE", n_crashes: 137 }), "west side", CC2MC2MN)).toEqual({
            label: "Duncan Ave",
            alias: "WEST SIDE AVE",
            description: "aka WEST SIDE AVE · Jersey City, Hudson · 137 crashes",
        })
    })
    it("omits the alias when the name matches", () => {
        expect(formatRoadHit(hit({ name: "W Side Ave", aliases: "WESTSIDE AVE", n_crashes: 872 }), "west side", CC2MC2MN)).toEqual({
            label: "W Side Ave",
            alias: null,
            description: "Jersey City, Hudson · 872 crashes",
        })
        expect(formatRoadHit(hit({ name: "Tonnelle Ave", sris: "09081122__" }), "tonnelle", CC2MC2MN)).toEqual({
            label: "Tonnelle Ave",
            alias: null,
            description: "North Bergen, Hudson · 1 crash",
        })
    })
})
