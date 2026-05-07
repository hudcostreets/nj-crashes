import { describe, it, expect } from "vitest"
import { parsePath } from "./parsePath"

describe("parsePath", () => {
    it("empty splat → root dir", () => {
        expect(parsePath("")).toEqual({ kind: "dir", prefix: "raw/" })
    })

    it("trailing-slash dir", () => {
        expect(parsePath("njdot/")).toEqual({ kind: "dir", prefix: "raw/njdot/" })
        expect(parsePath("njdot/data/2023/")).toEqual({
            kind: "dir", prefix: "raw/njdot/data/2023/",
        })
    })

    it("no-extension, no-slash auto-appends `/` (so /raw/njdot still lists)", () => {
        expect(parsePath("njdot")).toEqual({ kind: "dir", prefix: "raw/njdot/" })
        expect(parsePath("njdot/data/2023")).toEqual({
            kind: "dir", prefix: "raw/njdot/data/2023/",
        })
    })

    it("leading slash on splat is stripped", () => {
        expect(parsePath("/njdot/")).toEqual({ kind: "dir", prefix: "raw/njdot/" })
    })

    it("zip path → zip kind", () => {
        expect(parsePath("njdot/data/2022/NewJersey2022Drivers.zip")).toEqual({
            kind: "zip", path: "raw/njdot/data/2022/NewJersey2022Drivers.zip",
        })
    })

    it("parquet (`.pqt` and `.parquet`) → parquet kind", () => {
        expect(parsePath("njdot/data/2022/NewJersey2022Drivers.pqt")).toEqual({
            kind: "parquet", path: "raw/njdot/data/2022/NewJersey2022Drivers.pqt",
        })
        expect(parsePath("foo.parquet")).toEqual({ kind: "parquet", path: "raw/foo.parquet" })
    })

    it("text-y extensions → text kind", () => {
        for (const ext of ["txt", "tsv", "json", "md", "log"]) {
            expect(parsePath(`x.${ext}`)).toEqual({ kind: "text", path: `raw/x.${ext}` })
        }
    })

    it("csv → csv kind (table renderer)", () => {
        expect(parsePath("njdot/data/2024/Crash.csv")).toEqual({
            kind: "csv", path: "raw/njdot/data/2024/Crash.csv", ext: "csv",
        })
    })

    it("pdf → pdf kind", () => {
        expect(parsePath("njsp/data/annual-summaries/ptccr_23.pdf")).toEqual({
            kind: "pdf", path: "raw/njsp/data/annual-summaries/ptccr_23.pdf",
        })
    })

    it("unrecognized extension → binary kind", () => {
        expect(parsePath("foo.bin")).toEqual({ kind: "binary", path: "raw/foo.bin" })
    })

    it("zip entry: `<zip>!/<entry>` splits at `!/`", () => {
        expect(parsePath("njdot/data/2022/NewJersey2022Drivers.zip!/NewJersey2022Drivers.txt")).toEqual({
            kind: "zipEntry",
            path: "raw/njdot/data/2022/NewJersey2022Drivers.zip",
            entry: "NewJersey2022Drivers.txt",
        })
    })

    it("zip entry takes precedence over extension classification", () => {
        // Even though `.txt` would otherwise be `text`, the `!/` makes it zipEntry.
        const r = parsePath("a.zip!/b.txt")
        expect(r.kind).toBe("zipEntry")
    })

    it("URL-decoded entry names with spaces (regression: Cape May2023…)", () => {
        // What `location.pathname` actually delivers is percent-encoded.
        expect(parsePath("njdot/data/2023/CapeMay2023Pedestrians.zip!/Cape%20May2023Pedestrians.txt")).toEqual({
            kind: "zipEntry",
            path: "raw/njdot/data/2023/CapeMay2023Pedestrians.zip",
            entry: "Cape May2023Pedestrians.txt",
        })
    })

    it("malformed percent-escapes don't throw", () => {
        // decodeURIComponent("%E0%A4%A") throws URIError; we catch + fall back.
        expect(() => parsePath("foo/%E0%A4%A.txt")).not.toThrow()
    })

    it("no double-`raw/` if the splat already contains `raw/` (regression check)", () => {
        // The bug we previously hit was on the *href construction* side
        // (DirListing built `/raw/${e.key}` where e.key already had `raw/`),
        // but parsePath should still build a sensible R2 key if a stale
        // URL like `/raw/raw/njdot/` ever got generated. It would
        // resolve to `raw/raw/njdot/` and the worker would 404 — that's
        // the right behavior (don't silently strip the second `raw/`,
        // since legitimate keys could in theory have any path).
        expect(parsePath("raw/njdot/")).toEqual({
            kind: "dir", prefix: "raw/raw/njdot/",
        })
    })
})
