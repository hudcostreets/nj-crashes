import { describe, it, expect } from "vitest"
import { parseCsvLine } from "./csv"

describe("parseCsvLine", () => {
    it("simple unquoted fields", () => {
        expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"])
    })

    it("trailing empty field", () => {
        expect(parseCsvLine("a,b,")).toEqual(["a", "b", ""])
    })

    it("leading empty field", () => {
        expect(parseCsvLine(",b,c")).toEqual(["", "b", "c"])
    })

    it("all-empty line", () => {
        expect(parseCsvLine(",,")).toEqual(["", "", ""])
    })

    it("quoted field with comma", () => {
        expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"])
    })

    it("quoted field with escaped quote", () => {
        expect(parseCsvLine('a,"He said ""hi""",b')).toEqual(["a", 'He said "hi"', "b"])
    })

    it("doubled-quote inside quoted field is literal quote", () => {
        expect(parseCsvLine('"""a"""')).toEqual(['"a"'])
    })

    it("empty quoted field", () => {
        expect(parseCsvLine('a,"",b')).toEqual(["a", "", "b"])
    })

    it("AASHTO-style header line", () => {
        // First few columns of NJDOT 2024 Crash.csv
        const line = "DEPT_CASE_NUMBER,YEAR,COUNTY_NAME,MUNICIPALITY,CRASH_DATE,CRASH_TIME"
        expect(parseCsvLine(line)).toEqual([
            "DEPT_CASE_NUMBER", "YEAR", "COUNTY_NAME", "MUNICIPALITY", "CRASH_DATE", "CRASH_TIME",
        ])
    })

    it("quoted field with newline-like control char (passthrough)", () => {
        // Multi-line quoted fields are NOT supported — this test
        // documents that a literal `\r` inside quotes is preserved
        // as data (caller is responsible for stripping trailing \r).
        expect(parseCsvLine('a,"b\rc",d')).toEqual(["a", "b\rc", "d"])
    })

    it("empty input", () => {
        expect(parseCsvLine("")).toEqual([""])
    })

    it("single field, no comma", () => {
        expect(parseCsvLine("hello")).toEqual(["hello"])
    })
})
