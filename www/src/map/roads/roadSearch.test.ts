import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"
import {
    filterHits, formatRoadHit, hitBbox, pickWord, prefixEnd, queryTokens, queryWords, SYNONYMS, wordFilters,
    type RoadSearchRow,
} from "./roadSearch"

describe("SYNONYMS", () => {
    it("matches `njdot/road_outputs.py` `SYNONYMS` (which builds the index's tokens)", () => {
        const py = readFileSync(resolve(__dirname, "../../../../njdot/road_outputs.py"), "utf8")
        const m = /^SYNONYMS = (\{[\s\S]*?^\})/m.exec(py)
        expect(m).not.toBeNull()
        const json = m![1].replace(/'/g, '"').replace(/,(\s*[}\]])/g, "$1")
        expect(SYNONYMS).toEqual(JSON.parse(json))
    })
})

describe("queryTokens", () => {
    it("ASCII-folds, lower-cases and splits on anything non-alphanumeric (quotes, LIKE / regex syntax)", () => {
        expect(queryTokens(`  West-Side 'ave'%_ (.*) `)).toEqual(["west", "side", "ave"])
        expect(queryTokens(`'; DROP TABLE road_search; --`)).toEqual(["drop", "table", "road", "search"])
        expect(queryTokens("Muñoz Marín")).toEqual(["munoz", "marin"])
        expect(queryTokens("%_")).toEqual([])
    })
})

describe("queryWords", () => {
    it("canonicalizes words; the last is a prefix while it's being typed", () => {
        expect(queryWords("w side av")).toEqual([
            { word: "w", exact: ["west"], prefix: null },
            { word: "side", exact: ["side"], prefix: null },
            { word: "av", exact: ["avenue"], prefix: "av" },
        ])
        expect(queryWords("st pauls ")).toEqual([
            { word: "st", exact: ["street", "saint"], prefix: null },
            { word: "pauls", exact: ["pauls"], prefix: null },
        ])
    })
})

describe("pickWord", () => {
    const capped = new Set(["west", "avenue", "street"])
    const pick = (q: string) => pickWord(queryWords(q), capped)?.word ?? null
    it("picks the longest word whose tokens aren't capped", () => {
        expect(pick("west side avenue")).toEqual("side")
        expect(pick("kenn")).toEqual("kenn")
        expect(pick("jfk blvd")).toEqual("blvd")
        expect(pick("west avenue")).toEqual("avenue")
    })
    it("skips a lone 1-character prefix that isn't an abbreviation", () => {
        expect(pick("5 a")).toEqual("5")
        expect(pick("q")).toEqual(null)
        expect(pick("w")).toEqual("w")
    })
})

describe("wordFilters", () => {
    it("fetches the canonical tokens and, for the word being typed, a prefix range: one pushable filter each", () => {
        const [kenn] = queryWords("kenn")
        expect(wordFilters(kenn)).toEqual(["token >= 'kenn' AND token < 'keno'"])
        const [, side] = queryWords("west side ")
        expect(wordFilters(side)).toEqual(["token = 'side'"])
        const [st] = queryWords("st ")
        expect(wordFilters(st)).toEqual(["token = 'street'", "token = 'saint'"])
        const [blvd] = queryWords("blvd")
        expect(wordFilters(blvd)).toEqual(["token = 'boulevard'", "token >= 'blvd' AND token < 'blve'"])
        const [ave] = queryWords("ave")
        expect(wordFilters(ave)).toEqual(["token >= 'ave' AND token < 'avf'"])
        const [w] = queryWords("w")
        expect(wordFilters(w)).toEqual(["token = 'west'"])
    })
    it("bounds prefixes by incrementing their last character", () => {
        expect([prefixEnd("kenn"), prefixEnd("tz"), prefixEnd("a9")]).toEqual(["keno", "t{", "a:"])
    })
})

const row = (r: Partial<RoadSearchRow>): RoadSearchRow => ({
    entity: 1, slug: "hudson/road", name: "Road", matched: null, kind: "primary", words: "road", subt: 7,
    n_crashes: 1, place: "Hudson County", lon: -74, lat: 40.7, dx0: -100, dy0: -200, dx1: 300, dy1: 400, ...r,
})

describe("filterHits", () => {
    const rows = [
        row({ entity: 7, name: "J F Kennedy Boulevard", words: "j f kennedy boulevard", n_crashes: 27127 }),
        row({ entity: 7, name: "J F Kennedy Boulevard", matched: "Kennedy Boulevard", kind: "alias", words: "kennedy boulevard", n_crashes: 27127 }),
        row({ entity: 3, name: "Kennedy Street", words: "kennedy street", n_crashes: 108 }),
        row({ entity: 5, name: "Kennedy Avenue", words: "kennedy avenue", n_crashes: 400 }),
        row({ entity: 9, name: "Kenneth Place", words: "kenneth place", n_crashes: 12 }),
        row({ entity: 4, name: "West Side Avenue", words: "west side avenue", n_crashes: 880 }),
        row({ entity: 6, name: "Duncan Avenue", matched: "W Side Ave", kind: "alias", words: "west side avenue", n_crashes: 137 }),
        row({ entity: 8, name: "Westside Avenue", words: "westside avenue", n_crashes: 50 }),
    ]
    const hits = (q: string, limit = 10) => filterHits(rows, queryWords(q), limit).map(r => [r.entity, r.kind])
    it("keeps one row per road (primary name first), most crashes first", () => {
        expect(hits("kenn")).toEqual([[7, "primary"], [5, "primary"], [3, "primary"], [9, "primary"]])
        expect(hits("kenn", 2)).toEqual([[7, "primary"], [5, "primary"]])
    })
    it("requires every other query word to match a word of the name (abbreviations canonicalized)", () => {
        expect(hits("kennedy blvd")).toEqual([[7, "primary"]])
        expect(hits("kennedy st")).toEqual([[3, "primary"]])
        expect(hits("w side")).toEqual([[4, "primary"], [6, "alias"]])
        expect(hits("west side ave")).toEqual([[4, "primary"], [6, "alias"]])
        expect(hits("kennedy ")).toEqual([[7, "primary"], [5, "primary"], [3, "primary"]])
    })
})

describe("hitBbox", () => {
    it("adds the 1e-5° offsets to the point", () => {
        const [w, s, e, n] = hitBbox(row({}))
        expect([w, s, e, n].map(v => +v.toFixed(5))).toEqual([-74.001, 40.698, -73.997, 40.704])
    })
})

describe("formatRoadHit", () => {
    it("shows the alias / route that matched, then the place and crash count", () => {
        expect(formatRoadHit(row({ name: "Duncan Avenue", matched: "W Side Ave", kind: "alias", place: "Jersey City, Hudson", n_crashes: 137 }))).toEqual({
            label: "Duncan Avenue",
            description: "aka W Side Ave · Jersey City, Hudson · 137 crashes",
        })
        expect(formatRoadHit(row({ name: "J F Kennedy Boulevard", matched: "CR 501", kind: "route", n_crashes: 27127 }))).toEqual({
            label: "J F Kennedy Boulevard",
            description: "on CR 501 · Hudson County · 27,127 crashes",
        })
    })
    it("omits what's missing", () => {
        expect(formatRoadHit(row({ name: "Tonnelle Avenue", place: null }))).toEqual({
            label: "Tonnelle Avenue",
            description: "1 crash",
        })
    })
})
