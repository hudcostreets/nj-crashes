/** R2 → hyparquet AsyncBuffer adapter.
 *
 *  Hyparquet reads parquet via random-access byte ranges; on Cloudflare
 *  Workers the obvious way to do that is `R2Bucket.get(key, { range })`.
 *  Each `slice()` call issues one `R2.get`, which is fine for ~10 RG-prune-
 *  selected reads per request but should not be used in tight loops.
 */
import { parquetReadObjects } from "hyparquet"
import { decompress as zstdDecompress } from "fzstd"

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
function r2BufferOfSize(bucket: R2Bucket, key: string, byteLength: number): AsyncBuffer {
    return {
        byteLength,
        async slice(start: number, end?: number): Promise<ArrayBuffer> {
            const len = (end ?? byteLength) - start
            if (len <= 0) return new ArrayBuffer(0)
            const obj = await bucket.get(key, {
                range: { offset: start, length: len },
            })
            if (!obj) throw new Error(`R2 range fetch failed: ${key} [${start}..${end ?? "end"}]`)
            return obj.arrayBuffer()
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
    opts: { columns?: readonly string[]; filter?: object; missingOk?: boolean } = {},
): Promise<T[]> {
    const head = await bucket.head(key)
    if (!head) {
        if (opts.missingOk) return []
        throw new Error(`R2 key not found: ${key}`)
    }
    const file = r2BufferOfSize(bucket, key, head.size)
    const rows = await parquetReadObjects({
        file: file as any,
        columns: opts.columns as string[] | undefined,
        filter: opts.filter as any,
        compressors,
    })
    return rows as T[]
}
