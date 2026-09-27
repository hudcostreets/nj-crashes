/** A remote parquet file: its footer, read once per URL and shared by every query, and its byte
 *  ranges (specs/off-duckdb-wasm.md § Design). */
import { parquetMetadata, type AsyncBuffer, type FileMetaData } from "hyparquet"

/** A byte range `[start, end)`. */
export type ByteRange = { start: number; end: number }

/** A ranged read: `{ start, end }`, or the last `suffix` bytes. Resolves the bytes, where they start,
 *  and the file's total length (`Content-Range`; the whole body when a server ignores `Range`). */
export type RangeRequest = ByteRange | { suffix: number }
export type RangeResponse = { buf: ArrayBuffer; start: number; total: number }
export type RangeFetch = (req: RangeRequest) => Promise<RangeResponse>

/** Bytes fetched, per URL (all reads, incl. footers); for measurement. */
export const fetchStats = new Map<string, { requests: number; bytes: number }>()

function record(url: string, bytes: number) {
    const s = fetchStats.get(url) ?? { requests: 0, bytes: 0 }
    s.requests++
    s.bytes += bytes
    fetchStats.set(url, s)
}

/** `fetch` with a `Range` header. */
export function httpRangeFetch(url: string): RangeFetch {
    return async req => {
        const range = "suffix" in req ? `bytes=-${req.suffix}` : `bytes=${req.start}-${req.end - 1}`
        const res = await fetch(url, { headers: { Range: range } })
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (${range})`)
        const buf = await res.arrayBuffer()
        record(url, buf.byteLength)
        if (res.status === 200) return { buf, start: 0, total: buf.byteLength }
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "")
        if (m) {
            const total = +m[3]
            // Some servers (Vite's dev server, via sirv) read `bytes=-N` as `bytes=0-(N-1)`: then ask
            // for the tail explicitly, now that the length is known.
            if ("suffix" in req && +m[2] !== total - 1) {
                return httpRangeFetch(url)({ start: Math.max(0, total - req.suffix), end: total }).then(r => ({ ...r, total }))
            }
            return { buf, start: +m[1], total }
        }
        if ("suffix" in req) throw new Error(`${url}: no Content-Range on a suffix read (CORS Access-Control-Expose-Headers?)`)
        return { buf, start: req.start, total: NaN }
    }
}

/** Serve slices of `[start, start + buf.byteLength)`. */
type Held = { start: number; buf: ArrayBuffer }

function sliceHeld(held: readonly Held[], start: number, end: number): ArrayBuffer | null {
    for (const h of held) {
        if (start >= h.start && end <= h.start + h.buf.byteLength) return h.buf.slice(start - h.start, end - h.start)
    }
    return null
}

/** Ranges merged when less than `gap` bytes apart (one request instead of several). */
export function coalesce(ranges: readonly ByteRange[], gap: number): ByteRange[] {
    const sorted = [...ranges].sort((a, b) => a.start - b.start)
    const out: ByteRange[] = []
    for (const r of sorted) {
        const last = out[out.length - 1]
        if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end)
        else out.push({ ...r })
    }
    return out
}

/** First footer read. Small, since the whole read is wasted beyond the footer: bigger footers (the
 *  road files' are 15 KB–1 MB) cost one more, exact, read. Callers reading a small file whole pass a
 *  `tail` covering the file (one request). */
export const DEFAULT_TAIL = 1 << 16
export const DEFAULT_GAP = 1 << 16

export class ParquetFile {
    constructor(
        readonly url: string,
        readonly byteLength: number,
        readonly metadata: FileMetaData,
        /** The footer read (the whole file, when it's smaller than that read). */
        private readonly tail: Held,
        private readonly fetchRange: RangeFetch,
    ) {}

    /** Key-value metadata (`key_value_metadata`), as an object. */
    get kv(): Record<string, string> {
        const out: Record<string, string> = {}
        for (const { key, value } of this.metadata.key_value_metadata ?? []) if (value !== undefined) out[key] = value
        return out
    }

    /** Fetch `ranges` (coalesced across gaps < `gap`, in parallel; ranges inside the footer read are
     *  served from it), and return an `AsyncBuffer` over them for hyparquet. */
    async prefetch(ranges: readonly ByteRange[], gap = DEFAULT_GAP): Promise<AsyncBuffer> {
        const tailEnd = this.tail.start + this.tail.buf.byteLength
        const need = ranges.filter(r => !(r.start >= this.tail.start && r.end <= tailEnd))
        const held: Held[] = [this.tail]
        const fetched = await Promise.all(coalesce(need, gap).map(r => this.fetchRange(r).then(res => ({ start: res.start, buf: res.buf }))))
        held.push(...fetched)
        return {
            byteLength: this.byteLength,
            slice: (start: number, end?: number) => {
                const e = end ?? this.byteLength
                const hit = sliceHeld(held, start, e)
                if (hit) return hit
                return this.fetchRange({ start, end: e }).then(r => r.buf.slice(start - r.start, e - r.start))
            },
        }
    }
}

/** Read `url`'s footer: one suffix read of `tail` bytes, plus one read of the rest of the footer
 *  when it's bigger than that. */
export async function loadParquetFile(url: string, fetchRange: RangeFetch, tail = DEFAULT_TAIL): Promise<ParquetFile> {
    const first = await fetchRange({ suffix: tail })
    const total = first.total
    if (first.buf.byteLength < 8) throw new Error(`${url}: too short for parquet (${first.buf.byteLength} B)`)
    const view = new DataView(first.buf)
    if (view.getUint32(first.buf.byteLength - 4, true) !== 0x31524150) throw new Error(`${url}: not parquet (no PAR1 footer)`)
    const footerLen = view.getUint32(first.buf.byteLength - 8, true)
    const metaStart = total - 8 - footerLen
    let held: Held = { start: first.start, buf: first.buf }
    if (metaStart < first.start) {
        const rest = await fetchRange({ start: metaStart, end: first.start })
        const joined = new Uint8Array(rest.buf.byteLength + first.buf.byteLength)
        joined.set(new Uint8Array(rest.buf), 0)
        joined.set(new Uint8Array(first.buf), rest.buf.byteLength)
        held = { start: metaStart, buf: joined.buffer }
    }
    const footer = held.buf.slice(metaStart - held.start)
    const metadata = parquetMetadata(footer)
    return new ParquetFile(url, total, metadata, held, fetchRange)
}

const files = new Map<string, Promise<ParquetFile>>()

/** The file at `url`, footer read once per session (a failed read is retried next time). */
export function openParquet(url: string, opts: { tail?: number; fetch?: RangeFetch } = {}): Promise<ParquetFile> {
    let p = files.get(url)
    if (!p) {
        p = loadParquetFile(url, opts.fetch ?? httpRangeFetch(url), opts.tail)
        const q = p
        q.catch(() => { if (files.get(url) === q) files.delete(url) })
        files.set(url, p)
    }
    return p
}
