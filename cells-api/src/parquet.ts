/** R2 → hyparquet AsyncBuffer adapter.
 *
 *  Hyparquet reads parquet via random-access byte ranges; on Cloudflare
 *  Workers the obvious way to do that is `R2Bucket.get(key, { range })`.
 *  Each `slice()` call issues one `R2.get`, which is fine for ~10 RG-prune-
 *  selected reads per request but should not be used in tight loops.
 */
import { parquetReadObjects, parquetMetadataAsync } from "hyparquet"
import { decompress as zstdDecompress } from "fzstd"
import type { Timing } from "./timing"

/** Per-isolate cache of parsed parquet footers (`FileMetaData` + byteLength),
 *  keyed by R2 key. Schema-6 pyramid keys are content-hashed and never
 *  rewritten (specs/cells-immutable-keys.md), so a footer never goes stale
 *  within an isolate's life. (The legacy fixed-name layout was overwritten in
 *  place by `aws s3 sync`, which is why promotions moved to fresh prefixes
 *  before this.) Caching it means a
 *  pan/zoom that re-hits the same r4 shard skips both the footer range-fetch
 *  (up to ~264 KB for the deep r13-r15 files) and its parse — the dominant
 *  fixed per-request cost at deep zoom. LRU-capped so a broad session can't
 *  grow the isolate's heap unbounded (deep-file metadata is ~hundreds of KB). */
type CachedFooter = { byteLength: number; metadata: Awaited<ReturnType<typeof parquetMetadataAsync>> }
const FOOTER_CACHE = new Map<string, CachedFooter>()
const FOOTER_CACHE_MAX = 24

function footerCacheGet(key: string): CachedFooter | undefined {
    const v = FOOTER_CACHE.get(key)
    if (v) { FOOTER_CACHE.delete(key); FOOTER_CACHE.set(key, v) }  // LRU: bump to newest
    return v
}
function footerCacheSet(key: string, v: CachedFooter): void {
    FOOTER_CACHE.set(key, v)
    if (FOOTER_CACHE.size > FOOTER_CACHE_MAX) {
        FOOTER_CACHE.delete(FOOTER_CACHE.keys().next().value as string)  // evict oldest
    }
}

/** Test-only: clear the footer cache. */
export function _resetFooterCache(): void {
    FOOTER_CACHE.clear()
}

/** Codec map passed to hyparquet. The pipeline writes parquet with
 *  `compression='zstd'`; we use `fzstd` (pure JS, no WASM) for it.
 *  hyparquet-compressors won't load on CF Workers because it triggers
 *  runtime `WebAssembly.Module()` instantiation at module-load time,
 *  which is blocked by the Workers sandbox. */
const compressors = {
    ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => {
        const out = new Uint8Array(outputLength)
        zstdDecompress(input, out)
        return out
    },
}

/** Minimal AsyncBuffer interface required by hyparquet. */
export interface AsyncBuffer {
    byteLength: number
    slice(start: number, end?: number): Promise<ArrayBuffer>
}

/** Build an AsyncBuffer over an R2 object of known size, using Range GETs.
 *  The parquet footer is at the end of the object (last ~64 KB) and hyparquet
 *  reads it first; subsequent slice calls fetch the row groups it needs based
 *  on its filter pushdown. */
function r2BufferOfSize(bucket: R2Bucket, key: string, byteLength: number, timing?: Timing): AsyncBuffer {
    return {
        byteLength,
        async slice(start: number, end?: number): Promise<ArrayBuffer> {
            const len = (end ?? byteLength) - start
            if (len <= 0) return new ArrayBuffer(0)
            const t0 = Date.now()
            const obj = await bucket.get(key, {
                range: { offset: start, length: len },
            })
            if (!obj) throw new Error(`R2 range fetch failed: ${key} [${start}..${end ?? "end"}]`)
            const buf = await obj.arrayBuffer()
            timing?.add("r2", Date.now() - t0)
            timing?.count("r2_bytes", buf.byteLength)
            timing?.count("r2_gets", 1)
            return buf
        },
    }
}

/** A byte range `[start, end)`. */
export type ByteRange = { start: number; end: number }

/** Merge sorted-or-not byte ranges into fetch spans: ranges whose gap is
 *  ≤ `maxGap` bytes join one span, as long as the span stays ≤ `maxSpan`
 *  (a single range larger than `maxSpan` is still its own span). Returns
 *  spans sorted by start; each input range lies inside exactly one span. */
export function coalesceRanges(ranges: ByteRange[], maxGap: number, maxSpan: number): ByteRange[] {
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
    const spans: ByteRange[] = []
    for (const r of sorted) {
        const cur = spans.at(-1)
        if (cur && r.start - cur.end <= maxGap && Math.max(cur.end, r.end) - cur.start <= maxSpan) {
            cur.end = Math.max(cur.end, r.end)
        } else {
            spans.push({ start: r.start, end: r.end })
        }
    }
    return spans
}

/** Gap (bytes) worth over-reading to save a GET. The gaps inside a row group
 *  are the unprojected columns (mostly the label strings). Measured on the
 *  phone Jersey City view (2026-09-28): 256 KB → 2 GETs / 735 KB read;
 *  64 KB → 6 GETs / 106 KB (one parallel wave under the 6-connection cap);
 *  uncoalesced → 54 GETs / 80 KB. */
const COALESCE_MAX_GAP = 64 * 1024
/** Cap on one coalesced GET, so a wide read doesn't buffer one huge span. */
const COALESCE_MAX_SPAN = 16 * 1024 * 1024

/** Wrap an AsyncBuffer so every `slice` issued in the same synchronous burst
 *  is coalesced into as few underlying reads as possible.
 *
 *  hyparquet plans one byte range *per column chunk* when `columns` is set
 *  (it only merges runs for all-column reads), and issues them all in one
 *  synchronous `map` (`prefetchAsyncBuffer`). With 9 projected columns that
 *  was 9 R2 GETs per row group — 54-91 GETs for a phone-sized view
 *  (measured 2026-09-28) — and a Worker holds at most 6 subrequests open at
 *  once, so they queue. The chunks of one row group are contiguous on disk,
 *  so batching per microtask turns that into ~1 GET per run of row groups. */
export function coalescingBuffer(inner: AsyncBuffer, maxGap = COALESCE_MAX_GAP, maxSpan = COALESCE_MAX_SPAN): AsyncBuffer {
    type Pending = ByteRange & { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }
    let pending: Pending[] = []
    const flush = () => {
        const batch = pending
        pending = []
        for (const span of coalesceRanges(batch, maxGap, maxSpan)) {
            const members = batch.filter(p => p.start >= span.start && p.end <= span.end)
            inner.slice(span.start, span.end).then(
                buf => { for (const p of members) p.resolve(buf.slice(p.start - span.start, p.end - span.start)) },
                err => { for (const p of members) p.reject(err) },
            )
        }
    }
    return {
        byteLength: inner.byteLength,
        slice(start: number, end?: number): Promise<ArrayBuffer> {
            const e = end ?? inner.byteLength
            if (e - start <= 0) return Promise.resolve(new ArrayBuffer(0))
            return new Promise((resolve, reject) => {
                if (!pending.length) queueMicrotask(flush)
                pending.push({ start, end: e, resolve, reject })
            })
        },
    }
}

/** Build an AsyncBuffer backed by an R2 object. Throws if the key is missing. */
export async function r2AsyncBuffer(
    bucket: R2Bucket,
    key: string,
): Promise<AsyncBuffer> {
    const head = await bucket.head(key)
    if (!head) throw new Error(`R2 key not found: ${key}`)
    return r2BufferOfSize(bucket, key, head.size)
}

/** Read parquet rows from an R2 key with column projection + optional
 *  row-group pushdown filter. Returns an array of plain JS objects.
 *
 *  `missingOk`: when the key doesn't exist, return `[]` instead of throwing.
 *  Used by the pyramid/raw shard reads — the client's cover may include
 *  shards with no data (water/boundary), and an empty read is the correct
 *  answer. A single HEAD distinguishes missing from present, so this adds
 *  no extra round-trip on the hot (present) path. */
export async function readParquetFromR2<T>(
    bucket: R2Bucket,
    key: string,
    opts: { columns?: readonly string[]; filter?: object; missingOk?: boolean; timing?: Timing } = {},
): Promise<T[]> {
    const { timing } = opts
    let cached = footerCacheGet(key)
    if (!cached) {
        const t0 = Date.now()
        const head = await bucket.head(key)
        if (!head) {
            if (opts.missingOk) return []
            throw new Error(`R2 key not found: ${key}`)
        }
        const seedFile = r2BufferOfSize(bucket, key, head.size)
        const metadata = await parquetMetadataAsync(seedFile as any)
        cached = { byteLength: head.size, metadata }
        footerCacheSet(key, cached)
        timing?.add("footer", Date.now() - t0)
    } else {
        timing?.note("footer", "cached")
    }
    // Reuse the cached footer: the buffer's byteLength is known and the parsed
    // `metadata` is passed straight to hyparquet, so this read skips the footer
    // range-fetch + parse and issues only the row-group data GETs its filter
    // selects.
    const file = coalescingBuffer(r2BufferOfSize(bucket, key, cached.byteLength, timing))
    const t1 = Date.now()
    const rows = await parquetReadObjects({
        file: file as any,
        metadata: cached.metadata,
        columns: opts.columns as string[] | undefined,
        filter: opts.filter as any,
        compressors,
    })
    timing?.add("read", Date.now() - t1)
    timing?.count("rows", rows.length)
    return rows as T[]
}
