/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { readParquetFromR2, _resetFooterCache } from "./parquet"
import { s2IdToToken, s2Parent, s2RangeForCellToken, s2TokenToId } from "pyrmts-geo"

/** Real-data validation of the pyramid read path: one shard of
 *  `s2_pyramid/s2_l13/{l4}.parquet` (cellid-sorted, 4096-row groups) is read
 *  with a `cellid` range `$or` filter built from a viewport cover, and we
 *  assert (a) correctness — returned rows are exactly the cover's
 *  descendants — and (b) that hyparquet actually PRUNED row-groups, i.e.
 *  fetched far fewer bytes than a whole-file read.
 *
 *  This is the load-bearing optimization for the S2 stack specifically: the
 *  client's shard cover is the whole state at every zoom (NJ is two l4
 *  cells), so range pruning is the *only* thing keeping a street-zoom
 *  request from decoding a whole level file.
 *
 *  Skips if the l13 sample isn't present — the pyramid lives outside the
 *  repo, under DVX (`dvx pull data/cells/s2_pyramid.dvc`). */
const SHARD = "89d"
const L13_FILE = resolve(__dirname, `../../data/cells/s2_pyramid/s2_l13/${SHARD}.parquet`)
const HAVE = existsSync(L13_FILE)

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

/** l8 ancestor token of an l13 cell token — the "cover cell" granularity. */
const COVER_LEVEL = 8
const ancestor = (cellid: string) => s2IdToToken(s2Parent(s2TokenToId(cellid), COVER_LEVEL))

/** `$or` of `cellid BETWEEN` bounds — the same filter shape `queryPyramidS2`
 *  builds from `s2RangesForPolygon` ∩ shard ranges. */
function coverFilter(cover: string[]) {
    const ranges = cover.map(tok => s2RangeForCellToken(tok, 13))
    return { $or: ranges.map(r => ({ cellid: { $gte: r.lo, $lte: r.hi } })) }
}

const COLS = ["cellid", "year", "n_fatal", "sld_name"] as const

describe.skipIf(!HAVE)("s2 pyramid row-group pruning", () => {
    beforeEach(() => _resetFooterCache())

    it("prunes to the cover's row-groups and returns exactly its descendants", async () => {
        // Baseline: whole-file read (no filter) → ground-truth row set.
        const whole = fileBucket(L13_FILE)
        const allRows = await readParquetFromR2<any>(whole.bucket, "k", { columns: COLS as any })
        expect(allRows.length).toBeGreaterThan(100_000)

        // Cover = 3 distinct l8 cells drawn from across the shard.
        const picks = [allRows[0], allRows[allRows.length >> 1], allRows[allRows.length - 1]]
        const cover = [...new Set(picks.map(r => ancestor(r.cellid)))]
        expect(cover.length).toBe(3)
        const coverSet = new Set(cover)

        // Filtered read on a fresh byte-counting bucket.
        const pruned = fileBucket(L13_FILE)
        const got = await readParquetFromR2<any>(pruned.bucket, "k", {
            columns: COLS as any, filter: coverFilter(cover),
        })

        // Correctness: exactly the rows whose l8 ancestor is in the cover.
        const expected = allRows.filter(row => coverSet.has(ancestor(row.cellid)))
        expect(expected.length).toBeGreaterThan(0)
        expect(got.length).toBe(expected.length)
        expect(got.map(row => row.cellid).sort()).toEqual(expected.map(row => row.cellid).sort())

        // Pruning: fetched materially fewer bytes than the whole file.
        expect(pruned.bytes()).toBeLessThan(whole.total * 0.5)
    })

    it("caches the footer: a second read on the same key skips the HEAD + footer fetch", async () => {
        const filter = coverFilter([ancestor(await sampleCellid())])

        // First read on a cold cache: one HEAD (for size) + footer parse.
        const first = fileBucket(L13_FILE)
        const a = await readParquetFromR2<any>(first.bucket, SHARD, { columns: COLS as any, filter })
        expect(first.heads()).toBe(1)
        const firstBytes = first.bytes()

        // Second read, same key, warm cache: no HEAD, and fewer bytes than the
        // first (the footer range-fetch is skipped — only RG data GETs remain).
        const second = fileBucket(L13_FILE)
        const b = await readParquetFromR2<any>(second.bucket, SHARD, { columns: COLS as any, filter })
        expect(second.heads()).toBe(0)
        expect(second.bytes()).toBeLessThan(firstBytes)
        expect(b.length).toBe(a.length)
    })
})

/** A cellid from the middle of the sample shard — used to build a small cover. */
async function sampleCellid(): Promise<string> {
    _resetFooterCache()
    const fb = fileBucket(L13_FILE)
    const rows = await readParquetFromR2<any>(fb.bucket, SHARD, { columns: ["cellid"] as any })
    _resetFooterCache()
    return rows[rows.length >> 1].cellid
}
