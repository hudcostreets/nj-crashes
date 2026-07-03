import { describe, expect, it } from "vitest"
import { levenshtein, muniKey, suggestMunis } from "./county"

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
