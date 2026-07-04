import { describe, expect, it } from "vitest"
import { canonicalType, levenshtein, muniKey, parseSlug, slugMatchesMuni, suggestMunis } from "./county"

describe("muniKey", () => {
    it("expands NJDOT's abbreviated suffixes to the full form", () => {
        expect(muniKey("Hopewell Boro")).toBe("hopewell borough")
        expect(muniKey("Hopewell Twp")).toBe("hopewell township")
        expect(muniKey("Boro.")).toBe("borough")
        expect(muniKey("Twp.")).toBe("township")
    })

    it("leaves already-canonical names unchanged (idempotent)", () => {
        expect(muniKey("Hopewell Borough")).toBe("hopewell borough")
        expect(muniKey("Hopewell Township")).toBe("hopewell township")
        expect(muniKey("Pennington")).toBe("pennington")
        expect(muniKey(muniKey("Hopewell Boro"))).toBe("hopewell borough")
    })

    it("makes the abbreviated and full spellings resolve to the same key", () => {
        // This is the fix: muni-maps.json says "Hopewell Borough" while
        // cc2mc2mn.json says "Hopewell Boro" — both must key identically.
        expect(muniKey("Hopewell Boro")).toBe(muniKey("Hopewell Borough"))
        expect(muniKey("Hopewell Twp")).toBe(muniKey("Hopewell Township"))
    })

    it("does not collide Borough and Township of the same town", () => {
        // Expanding (not stripping) the suffix keeps them distinct.
        expect(muniKey("Hopewell Borough")).not.toBe(muniKey("Hopewell Township"))
        expect(muniKey("Hopewell Boro")).not.toBe(muniKey("Hopewell Twp"))
    })

    it("does not mangle 'boro'/'twp' embedded inside a name", () => {
        // e.g. Marlboro (Monmouth) — 'boro' isn't a standalone suffix here.
        expect(muniKey("Marlboro")).toBe("marlboro")
        expect(muniKey("Marlboro Twp")).toBe("marlboro township")
    })

    it("normalizes case (lowercase, all-caps, mixed) to one key", () => {
        // Slugs land here after `denormalize` (title-case) but URL
        // resolvers may also compare against raw-case NJDOT strings —
        // guarantee case doesn't affect the key.
        expect(muniKey("egg harbor twp")).toBe(muniKey("Egg Harbor Twp"))
        expect(muniKey("EGG HARBOR TWP")).toBe(muniKey("Egg Harbor Twp"))
        expect(muniKey("HoPeWeLl BoRo")).toBe("hopewell borough")
    })
})

describe("canonicalType", () => {
    it("folds boro/borough variants", () => {
        expect(canonicalType("boro")).toBe("boro")
        expect(canonicalType("Boro")).toBe("boro")
        expect(canonicalType("Boro.")).toBe("boro")
        expect(canonicalType("Borough")).toBe("boro")
    })
    it("folds twp/township variants", () => {
        expect(canonicalType("twp")).toBe("twp")
        expect(canonicalType("Twp.")).toBe("twp")
        expect(canonicalType("Township")).toBe("twp")
    })
    it("returns undefined for non-type words", () => {
        expect(canonicalType("hopewell")).toBeUndefined()
        expect(canonicalType("mercer")).toBeUndefined()
    })
})

describe("parseSlug", () => {
    it("splits `stem-type` slug into stem + canonical type", () => {
        expect(parseSlug("hopewell-boro")).toEqual({ stem: "hopewell", type: "boro" })
        expect(parseSlug("hopewell-twp")).toEqual({ stem: "hopewell", type: "twp" })
        expect(parseSlug("Hopewell Boro")).toEqual({ stem: "hopewell", type: "boro" })
        expect(parseSlug("Hopewell Township")).toEqual({ stem: "hopewell", type: "twp" })
        expect(parseSlug("hopewell-borough")).toEqual({ stem: "hopewell", type: "boro" })
    })
    it("leaves multi-word stems intact when no trailing type", () => {
        expect(parseSlug("new-providence")).toEqual({ stem: "new providence" })
        expect(parseSlug("East Windsor")).toEqual({ stem: "east windsor" })
    })
    it("keeps `city` as type", () => {
        expect(parseSlug("jersey-city")).toEqual({ stem: "jersey", type: "city" })
        expect(parseSlug("Union City")).toEqual({ stem: "union", type: "city" })
    })
    it("returns just stem when there's no trailing type token", () => {
        expect(parseSlug("hopewell")).toEqual({ stem: "hopewell" })
        expect(parseSlug("trenton")).toEqual({ stem: "trenton" })
    })
})

describe("slugMatchesMuni", () => {
    // Real-world case: `/hopewell` should offer Cumberland (stored as
    // suffix-less "Hopewell"), Mercer Boro, Mercer Twp all as picker options.
    it("wildcards on stem alone when input has no type", () => {
        const input = parseSlug("hopewell")
        expect(slugMatchesMuni(input, parseSlug("Hopewell"))).toBe(true)          // Cumberland
        expect(slugMatchesMuni(input, parseSlug("Hopewell Boro"))).toBe(true)     // Mercer B
        expect(slugMatchesMuni(input, parseSlug("Hopewell Twp"))).toBe(true)      // Mercer T
        expect(slugMatchesMuni(input, parseSlug("Hightstown"))).toBe(false)       // different stem
    })
    // `/hopewell-boro` sends Danny (Hopewell Mercer) to Mercer, not Cumberland.
    it("strict-matches type when input specifies one", () => {
        const input = parseSlug("hopewell-boro")
        expect(slugMatchesMuni(input, parseSlug("Hopewell Boro"))).toBe(true)     // Mercer B — match
        expect(slugMatchesMuni(input, parseSlug("Hopewell Twp"))).toBe(false)     // Mercer T — wrong type
        expect(slugMatchesMuni(input, parseSlug("Hopewell"))).toBe(false)         // Cumberland — no stored type
    })
    it("keeps `Jersey City` reachable via both /jersey and /jersey-city", () => {
        expect(slugMatchesMuni(parseSlug("jersey"), parseSlug("Jersey City"))).toBe(true)
        expect(slugMatchesMuni(parseSlug("jersey-city"), parseSlug("Jersey City"))).toBe(true)
        // But `/jersey-twp` should NOT match Jersey City (wrong type).
        expect(slugMatchesMuni(parseSlug("jersey-twp"), parseSlug("Jersey City"))).toBe(false)
    })
})

describe("levenshtein", () => {
    it("returns 0 for identical strings", () => {
        expect(levenshtein("", "")).toBe(0)
        expect(levenshtein("foo", "foo")).toBe(0)
    })
    it("returns length when one side is empty", () => {
        expect(levenshtein("", "foo")).toBe(3)
        expect(levenshtein("foo", "")).toBe(3)
    })
    it("counts single-character edits", () => {
        expect(levenshtein("cat", "bat")).toBe(1)   // substitution
        expect(levenshtein("cat", "cats")).toBe(1)  // insertion
        expect(levenshtein("cats", "cat")).toBe(1)  // deletion
    })
    it("counts multi-character edits", () => {
        expect(levenshtein("kitten", "sitting")).toBe(3)
        expect(levenshtein("hopewell-borough", "hopewell-borogh")).toBe(1)
    })
})

describe("suggestMunis", () => {
    const mercerMc2mn = {
        1: "Trenton", 2: "Robbinsville", 3: "Hamilton", 4: "Hightstown",
        5: "Hopewell Borough", 6: "Hopewell Township", 7: "Ewing",
        8: "Pennington", 9: "Princeton",
    }
    it("ranks near-matches ahead of unrelated names", () => {
        // Typo: dropped 'e' before 'll'
        const suggestions = suggestMunis("hopwell-borough", mercerMc2mn)
        expect(suggestions.length).toBeGreaterThan(0)
        expect(suggestions[0].mn).toBe("Hopewell Borough")
    })
    it("returns both Hopewell munis for `hopewell` slug", () => {
        const suggestions = suggestMunis("hopewell", mercerMc2mn, { limit: 3 })
        const names = suggestions.map(s => s.mn)
        expect(names).toContain("Hopewell Borough")
        expect(names).toContain("Hopewell Township")
    })
    it("respects the `limit` parameter", () => {
        const suggestions = suggestMunis("hopewell", mercerMc2mn, { limit: 1 })
        expect(suggestions.length).toBe(1)
    })
    it("filters out low-similarity matches under threshold", () => {
        // A slug with nothing in common with any muni
        const suggestions = suggestMunis("qqqqqqqqqqqqqqqq", mercerMc2mn)
        expect(suggestions).toEqual([])
    })
    it("still surfaces a suggestion for a badly-typoed but recognizable slug", () => {
        // Two typos in a longer name
        const suggestions = suggestMunis("robbinsvile", mercerMc2mn)
        expect(suggestions.map(s => s.mn)).toContain("Robbinsville")
    })
})
