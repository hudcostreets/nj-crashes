import { describe, expect, it } from "vitest"
import { levenshtein, suggestMunis } from "./county"

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
