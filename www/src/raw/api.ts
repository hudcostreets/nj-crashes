/** Typed fetch helpers for the `/v1/raw/*` endpoints (see
 *  `cells-api/src/raw.ts`).
 *
 *  All paths/prefixes here include the `raw/` prefix verbatim — the
 *  caller is responsible for prepending it. We don't add it
 *  automatically because the URL splat (`/raw/<rest>`) maps 1:1 to the
 *  R2 key, and adding/stripping `raw/` in two places leads to bugs.
 */
import { CELLS_API_BASE } from "../map/config"

/** Per-deploy cache-buster appended to worker URLs. Increment when
 *  a worker-side change touches cached headers (e.g. CORS) — the CF
 *  edge cache otherwise serves stale responses with old headers
 *  until `Cache-Control: max-age=86400, immutable` expires (24 h).
 *
 *  Bump history:
 *    1 — initial
 *    2 — 2026-05-07: `Access-Control-Expose-Headers: Content-Range, …`
 */
const RAW_CACHE_VERSION = "2"

export type ListEntry = {
    key: string
    size?: number
    lastModified?: string
    isDir: boolean
}

export type ZipEntry = {
    name: string
    size: number
    compressedSize: number
    offset: number
    method: number
    crc32: number
    lastModified?: string
}

export type ZipEntriesResponse = {
    entries: ZipEntry[]
    totalSize: number
    totalCompressed: number
}

export async function fetchList(prefix: string, cursor?: string): Promise<{ entries: ListEntry[]; cursor?: string }> {
    const params = new URLSearchParams({ prefix })
    if (cursor) params.set("cursor", cursor)
    const res = await fetch(`${CELLS_API_BASE}/v1/raw/list?${params}`)
    if (!res.ok) throw new Error(`list ${prefix}: ${res.status} ${await res.text()}`)
    return res.json()
}

export async function fetchZipEntries(path: string): Promise<ZipEntriesResponse> {
    const params = new URLSearchParams({ path })
    const res = await fetch(`${CELLS_API_BASE}/v1/raw/zip-entries?${params}`)
    if (!res.ok) throw new Error(`zip-entries ${path}: ${res.status} ${await res.text()}`)
    return res.json()
}

export function rawGetUrl(path: string): string {
    return `${CELLS_API_BASE}/v1/raw/get?path=${encodeURIComponent(path)}&_v=${RAW_CACHE_VERSION}`
}

export function rawZipEntryUrl(path: string, e: ZipEntry, max?: number): string {
    const params = new URLSearchParams({
        path,
        entry: e.name,
        offset: String(e.offset),
        csize: String(e.compressedSize),
        method: String(e.method),
    })
    if (max != null) params.set("max", String(max))
    params.set("_v", RAW_CACHE_VERSION)
    return `${CELLS_API_BASE}/v1/raw/zip-entry?${params}`
}

/** Range-fetch a slice of an R2 object via /v1/raw/get. Returns the
 *  bytes + the total file size from `Content-Range`. */
export async function rangeFetch(
    path: string,
    offset: number,
    length: number,
): Promise<{ bytes: Uint8Array; total: number }> {
    const url = rawGetUrl(path)
    const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    })
    if (!res.ok && res.status !== 206) {
        throw new Error(`range ${path} [${offset}, ${offset + length}): ${res.status}`)
    }
    const cr = res.headers.get("Content-Range")
    const total = cr ? parseInt(cr.split("/")[1], 10) : -1
    const buf = await res.arrayBuffer()
    return { bytes: new Uint8Array(buf), total }
}

/** HEAD-equivalent: do a 1-byte range to learn the file size cheaply. */
export async function fetchSize(path: string): Promise<number> {
    const { total } = await rangeFetch(path, 0, 1)
    if (total < 0) throw new Error(`no Content-Range for ${path}`)
    return total
}

export function fmtSize(n: number | undefined): string {
    if (n === undefined) return ""
    if (n < 1024) return `${n} B`
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function basename(key: string): string {
    const trimmed = key.replace(/\/+$/, "")
    const i = trimmed.lastIndexOf("/")
    return i < 0 ? trimmed : trimmed.slice(i + 1)
}

export function extOf(name: string): string {
    const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
    return m ? m[1] : ""
}
