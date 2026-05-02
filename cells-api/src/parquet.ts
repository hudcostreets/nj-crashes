/** R2 → hyparquet AsyncBuffer adapter.
 *
 *  Hyparquet reads parquet via random-access byte ranges; on Cloudflare
 *  Workers the obvious way to do that is `R2Bucket.get(key, { range })`.
 *  Each `slice()` call issues one `R2.get`, which is fine for ~10 RG-prune-
 *  selected reads per request but should not be used in tight loops.
 */
import { parquetReadObjects } from "hyparquet"

/** Minimal AsyncBuffer interface required by hyparquet. */
export interface AsyncBuffer {
    byteLength: number
    slice(start: number, end?: number): Promise<ArrayBuffer>
}

/** Build an AsyncBuffer backed by an R2 object, using Range GETs. The
 *  parquet footer is at the end of the object (last ~64 KB) and hyparquet
 *  reads it first; subsequent slice calls fetch the row groups it needs
 *  based on its filter pushdown. */
export async function r2AsyncBuffer(
    bucket: R2Bucket,
    key: string,
): Promise<AsyncBuffer> {
    const head = await bucket.head(key)
    if (!head) throw new Error(`R2 key not found: ${key}`)
    const byteLength = head.size
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

/** Read parquet rows from an R2 key with column projection + optional
 *  row-group pushdown filter. Returns an array of plain JS objects. */
export async function readParquetFromR2<T>(
    bucket: R2Bucket,
    key: string,
    opts: { columns?: readonly string[]; filter?: object } = {},
): Promise<T[]> {
    const file = await r2AsyncBuffer(bucket, key)
    const rows = await parquetReadObjects({
        file: file as any,
        columns: opts.columns as string[] | undefined,
        filter: opts.filter as any,
    })
    return rows as T[]
}
