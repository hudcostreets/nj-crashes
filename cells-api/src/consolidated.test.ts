/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { cellToParent } from "h3-js"
import { readParquetFromR2, _resetFooterCache } from "./parquet"
import { rangesForCovering } from "./h3-range"

/** Real-data validation of the consolidated-pyramid read path: a single
 *  r4-sharded `pyramid/r13/{r4}.parquet` (h3-sorted, 4096-row groups) is
 *  read with an h3-range `$or` filter built from a viewport cover, and we
 *  assert (a) correctness — returned rows are exactly the cover's
 *  descendants — and (b) that hyparquet actually PRUNED row-groups, i.e.
 *  fetched far fewer bytes than a whole-file read.
 *
 *  Skips if the r13 sample isn't present (the build lives outside the repo,
 *  under DVC). */
const R4 = "842a107ffffffff"
const R13_FILE = resolve(__dirname, `../../data/cells/pyramid/r13/${R4}.parquet`)
const HAVE = existsSync(R13_FILE)

/** Fake R2Bucket over a local file, counting bytes actually range-fetched. */
function fileBucket(path: string) {
    const buf = readFileSync(path)
    let bytesFetched = 0
    let headCount = 0
    const bucket = {
        async head(_key: string) {
            headCount++
            return { size: buf.length }
        },
        async get(_key: string, opts?: { range?: { offset: number; length: number } }) {
            const off = opts?.range?.offset ?? 0
            const len = opts?.range?.length ?? buf.length - off
            bytesFetched += len
            const slice = buf.subarray(off, off + len)
            return { async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) } }
        },
    } as unknown as R2Bucket
    return { bucket, bytes: () => bytesFetched, heads: () => headCount, total: buf.length }
}

const bigintToHex = (b: bigint | number) => BigInt(b).toString(16)
const COLS = ["h3_r13", "year", "n_fatal", "sld_name"] as const

describe.skipIf(!HAVE)("consolidated r13 row-group pruning", () => {
    beforeEach(() => _resetFooterCache())

    it("prunes to the cover's row-groups and returns exactly its descendants", async () => {
        // Baseline: whole-file read (no filter) → ground-truth row set.
        const whole = fileBucket(R13_FILE)
        const allRows = await readParquetFromR2<any>(whole.bucket, "k", { columns: COLS as any })
        expect(allRows.length).toBeGreaterThan(100_000)

        // Cover = 3 distinct r7 cells drawn from across the shard.
        const r7 = (row: any) => cellToParent(bigintToHex(row.h3_r13), 7)
        const picks = [allRows[0], allRows[allRows.length >> 1], allRows[allRows.length - 1]]
        const cover = [...new Set(picks.map(r7))]
        expect(cover.length).toBe(3)
        const coverSet = new Set(cover)

        const ranges = rangesForCovering(cover.map(h => BigInt(`0x${h}`)), 7, 13)
        const filter = { $or: ranges.map(r => ({ h3_r13: { $gte: r.lo, $lte: r.hi } })) }

        // Filtered read on a fresh byte-counting bucket.
        const pruned = fileBucket(R13_FILE)
        const got = await readParquetFromR2<any>(pruned.bucket, "k", { columns: COLS as any, filter })

        // Correctness: exactly the rows whose r7 ancestor is in the cover.
        const expected = allRows.filter(row => coverSet.has(r7(row)))
        expect(expected.length).toBeGreaterThan(0)
        expect(got.length).toBe(expected.length)
        expect(got.every(row => coverSet.has(r7(row)))).toBe(true)

        // Pruning: fetched materially fewer bytes than the whole file.
        expect(pruned.bytes()).toBeLessThan(whole.total * 0.5)
    })

    it("caches the footer: a second read on the same key skips the HEAD + footer fetch", async () => {
        const cover = [cellToParent((await sampleR13()), 7)]
        const ranges = rangesForCovering(cover.map(h => BigInt(`0x${h}`)), 7, 13)
        const filter = { $or: ranges.map(r => ({ h3_r13: { $gte: r.lo, $lte: r.hi } })) }

        // First read on a cold cache: one HEAD (for size) + footer parse.
        const first = fileBucket(R13_FILE)
        const a = await readParquetFromR2<any>(first.bucket, R4, { columns: COLS as any, filter })
        expect(first.heads()).toBe(1)
        const firstBytes = first.bytes()

        // Second read, same key, warm cache: no HEAD, and fewer bytes than the
        // first (the footer range-fetch is skipped — only RG data GETs remain).
        const second = fileBucket(R13_FILE)
        const b = await readParquetFromR2<any>(second.bucket, R4, { columns: COLS as any, filter })
        expect(second.heads()).toBe(0)
        expect(second.bytes()).toBeLessThan(firstBytes)
        expect(b.length).toBe(a.length)
    })
})

/** First r13 cell hex in the sample shard — used to build a small cover. */
async function sampleR13(): Promise<string> {
    _resetFooterCache()
    const fb = fileBucket(R13_FILE)
    const rows = await readParquetFromR2<any>(fb.bucket, R4, { columns: ["h3_r13"] as any })
    _resetFooterCache()
    return bigintToHex(rows[rows.length >> 1].h3_r13)
}
