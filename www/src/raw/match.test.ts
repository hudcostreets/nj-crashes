import { describe, it, expect } from "vitest"
import { makeMatcher, globToRegex } from "./match"

describe("makeMatcher", () => {
    it("empty query matches everything", () => {
        const m = makeMatcher("")
        expect(m("anything")).toBe(true)
        expect(m("")).toBe(true)
    })

    it("bare text → case-insensitive substring", () => {
        const m = makeMatcher("pedestr")
        expect(m("NewJersey2022Pedestrians.zip")).toBe(true)
        expect(m("pedestrians")).toBe(true)
        expect(m("PEDESTRIANS")).toBe(true)
        expect(m("Drivers.zip")).toBe(false)
    })

    it("`*` switches to anchored glob", () => {
        const m = makeMatcher("NewJersey*")
        expect(m("NewJersey2022Drivers.zip")).toBe(true)
        expect(m("NewJersey")).toBe(true)
        expect(m("Atlantic2023Drivers.zip")).toBe(false)
        // Anchored: NJ in the *middle* of a string doesn't match.
        expect(m("xNewJerseyx")).toBe(false)
    })

    it("`?` switches to anchored glob (single char)", () => {
        const m = makeMatcher("foo?.txt")
        expect(m("foo1.txt")).toBe(true)
        expect(m("fooA.txt")).toBe(true)
        expect(m("foo.txt")).toBe(false)
        expect(m("foo12.txt")).toBe(false)
    })

    it("globs are case-insensitive", () => {
        const m = makeMatcher("NEWJERSEY*")
        expect(m("NewJersey2022Drivers.zip")).toBe(true)
    })

    it("regex metacharacters in glob are escaped (no blow-up)", () => {
        const m = makeMatcher("(2023)*")  // would be a regex group otherwise
        expect(m("(2023)Foo.zip")).toBe(true)
        expect(m("2023Foo.zip")).toBe(false)
    })

    it("dot is literal in glob mode", () => {
        const m = makeMatcher("*.zip")
        expect(m("foo.zip")).toBe(true)
        expect(m("foo_zip")).toBe(false)  // `.` should be literal, not regex `.`
    })
})

describe("globToRegex", () => {
    it("trivial cases", () => {
        expect(globToRegex("*").source).toBe("^.*$")
        expect(globToRegex("?").source).toBe("^.$")
    })

    it("escapes regex metacharacters", () => {
        expect(globToRegex("a.b").test("a.b")).toBe(true)
        expect(globToRegex("a.b").test("axb")).toBe(false)
        expect(globToRegex("(x)").test("(x)")).toBe(true)
        expect(globToRegex("a+b").test("a+b")).toBe(true)
    })

    it("compiles `*` and `?` to regex equivalents", () => {
        expect(globToRegex("a*c").test("abc")).toBe(true)
        expect(globToRegex("a*c").test("axxxxxc")).toBe(true)
        expect(globToRegex("a?c").test("abc")).toBe(true)
        expect(globToRegex("a?c").test("ac")).toBe(false)
    })
})
