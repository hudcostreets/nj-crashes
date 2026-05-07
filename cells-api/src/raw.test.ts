import { describe, it, expect } from "vitest"
import { deflateSync, inflateSync } from "fflate"
import { inflateUpTo } from "./raw"

/** Build raw-DEFLATE-compressed bytes (matches what zip's `method=8`
 *  stores — no zlib/gzip header). fflate's `deflateSync` produces
 *  raw DEFLATE, which `inflateSync` consumes by default. */
function deflate(text: string): Uint8Array {
    return deflateSync(new TextEncoder().encode(text))
}

describe("inflateUpTo", () => {
    it("returns full output when max ≥ uncompressed size", () => {
        const text = "hello world\n".repeat(100)
        const compressed = deflate(text)
        const { body, truncated } = inflateUpTo(compressed, text.length * 2)
        expect(truncated).toBe(false)
        expect(new TextDecoder().decode(body)).toBe(text)
    })

    it("truncates at exactly `max` bytes", () => {
        const text = "abcdefghij".repeat(10000)  // 100k bytes
        const compressed = deflate(text)
        const { body, truncated } = inflateUpTo(compressed, 1024)
        expect(truncated).toBe(true)
        expect(body.length).toBe(1024)
        expect(new TextDecoder().decode(body)).toBe(text.slice(0, 1024))
    })

    it("highly compressible input: bounded output despite large input", () => {
        // 1 MB of 'A' compresses to ~1 KB. Capping at 256 bytes should
        // produce exactly 256 'A' bytes regardless of input shape.
        const text = "A".repeat(1024 * 1024)
        const compressed = deflate(text)
        const { body, truncated } = inflateUpTo(compressed, 256)
        expect(truncated).toBe(true)
        expect(body.length).toBe(256)
        expect(new TextDecoder().decode(body)).toBe("A".repeat(256))
    })

    it("output exactly == max → not truncated (boundary)", () => {
        const text = "x".repeat(1000)
        const compressed = deflate(text)
        const { body, truncated } = inflateUpTo(compressed, 1000)
        expect(truncated).toBe(false)
        expect(body.length).toBe(1000)
    })

    it("max larger than 64 KB chunk size still works (multi-chunk)", () => {
        // Forces fflate's ondata to fire multiple times.
        const text = "x".repeat(200 * 1024)  // 200 KB
        const compressed = deflate(text)
        const { body, truncated } = inflateUpTo(compressed, 150 * 1024)
        expect(truncated).toBe(true)
        expect(body.length).toBe(150 * 1024)
    })

    it("round-trip via inflateSync gives same bytes (sanity)", () => {
        const text = "round-trip\n".repeat(500)
        const compressed = deflate(text)
        const a = inflateSync(compressed)
        const { body } = inflateUpTo(compressed, text.length)
        expect(body).toEqual(a)
    })
})
