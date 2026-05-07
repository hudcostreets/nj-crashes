/** `/v1/raw/*` handlers — thin file-browser surface over the
 *  `nj-crashes/raw/` R2 prefix. See `specs/raw-file-browser.md`.
 *
 *  Endpoints:
 *    GET /v1/raw/list?prefix=<p>[&cursor=<c>]
 *    GET /v1/raw/get?path=<k>                 (Range-friendly proxy)
 *    GET /v1/raw/zip-entries?path=<k>         (parses central directory)
 *    GET /v1/raw/zip-entry?path=<k>&entry=<n>&offset=<o>&csize=<s>&method=<m>
 *
 *  Security: every R2 key derived from the request must begin with
 *  `raw/`. Other prefixes on the bucket (`cells/`, future siblings) are
 *  off-limits.
 */
import { inflateSync } from "fflate"
import { HttpError } from "./cells"

const RAW_PREFIX = "raw/"

/** Reject paths that don't live under `raw/`. Also strips a leading
 *  slash if present (URL splat tends to include one). */
function normalizeRawPath(p: string | null, label: string): string {
    if (!p) throw new HttpError(400, `${label} is required`)
    const trimmed = p.replace(/^\/+/, "")
    if (!trimmed.startsWith(RAW_PREFIX)) {
        throw new HttpError(400, `${label} must start with "${RAW_PREFIX}"`)
    }
    return trimmed
}

/** ---------- /v1/raw/list ---------- */

export type ListEntry = {
    key: string
    size?: number
    lastModified?: string
    isDir: boolean
}

export type ListResponse = {
    entries: ListEntry[]
    cursor?: string
}

export async function handleList(bucket: R2Bucket, url: URL): Promise<ListResponse> {
    const rawPrefix = url.searchParams.get("prefix") ?? RAW_PREFIX
    const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`
    if (!prefix.startsWith(RAW_PREFIX)) {
        throw new HttpError(400, `prefix must start with "${RAW_PREFIX}"`)
    }
    const cursor = url.searchParams.get("cursor") ?? undefined

    const result = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 })

    const entries: ListEntry[] = []
    for (const dir of result.delimitedPrefixes ?? []) {
        entries.push({ key: dir, isDir: true })
    }
    for (const obj of result.objects ?? []) {
        // R2 yields the prefix itself as a 0-byte object when the
        // "directory" was created via console — skip those.
        if (obj.key === prefix) continue
        entries.push({
            key: obj.key,
            size: obj.size,
            lastModified: obj.uploaded.toISOString(),
            isDir: false,
        })
    }
    // Stable order: dirs first (already), then files alpha.
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.key.localeCompare(b.key)
    })

    return {
        entries,
        ...(result.truncated && result.cursor ? { cursor: result.cursor } : {}),
    }
}

/** ---------- /v1/raw/get ---------- */

const CONTENT_TYPES: Record<string, string> = {
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    json: "application/json",
    md: "text/markdown; charset=utf-8",
    pqt: "application/octet-stream",
    parquet: "application/octet-stream",
    zip: "application/zip",
}

function contentTypeFor(key: string): string {
    const ext = key.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
    return (ext && CONTENT_TYPES[ext]) || "application/octet-stream"
}

/** Parse a single-range header `bytes=N-M` (ignore multi-range). */
function parseRange(h: string | null, size: number): { offset: number; length: number } | null {
    if (!h) return null
    const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
    if (!m) return null
    const startStr = m[1], endStr = m[2]
    if (!startStr && !endStr) return null
    let start: number, end: number
    if (!startStr) {
        // suffix range: last N bytes
        const suffix = parseInt(endStr, 10)
        if (!Number.isFinite(suffix) || suffix <= 0) return null
        start = Math.max(0, size - suffix)
        end = size - 1
    } else {
        start = parseInt(startStr, 10)
        end = endStr ? parseInt(endStr, 10) : size - 1
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    }
    if (start < 0 || start > end || start >= size) return null
    end = Math.min(end, size - 1)
    return { offset: start, length: end - start + 1 }
}

export async function handleGet(
    bucket: R2Bucket,
    url: URL,
    request: Request,
): Promise<Response> {
    const path = normalizeRawPath(url.searchParams.get("path"), "path")

    // HEAD-style first to know the size for Range parsing.
    const head = await bucket.head(path)
    if (!head) throw new HttpError(404, `not found: ${path}`)

    const ifNoneMatch = request.headers.get("If-None-Match")
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, "") === head.etag) {
        return new Response(null, {
            status: 304,
            headers: { ETag: `"${head.etag}"` },
        })
    }

    const range = parseRange(request.headers.get("Range"), head.size)
    const obj = range
        ? await bucket.get(path, { range: { offset: range.offset, length: range.length } })
        : await bucket.get(path)
    if (!obj) throw new HttpError(404, `not found: ${path}`)

    const headers: Record<string, string> = {
        "Content-Type": contentTypeFor(path),
        "ETag": `"${head.etag}"`,
        "Cache-Control": "public, max-age=86400, immutable",
        "Accept-Ranges": "bytes",
    }
    if (range) {
        headers["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`
        headers["Content-Length"] = String(range.length)
        return new Response(obj.body, { status: 206, headers })
    }
    headers["Content-Length"] = String(head.size)
    return new Response(obj.body, { status: 200, headers })
}

/** ---------- /v1/raw/zip-entries ---------- */

export type ZipEntry = {
    name: string
    size: number          // uncompressed
    compressedSize: number
    offset: number        // local-file-header offset within the zip
    method: number        // 0 = STORE, 8 = DEFLATE
    crc32: number
    lastModified?: string
}

export type ZipEntriesResponse = {
    entries: ZipEntry[]
    totalSize: number      // sum of entry uncompressed sizes
    totalCompressed: number
}

const EOCD_SIG = 0x06054b50
const EOCD_MIN = 22
const EOCD_MAX = 22 + 0xffff   // EOCD + max comment length
const CD_ENTRY_SIG = 0x02014b50
const ZIP64_LOCATOR_SIG = 0x07064b50

/** Read the End-Of-Central-Directory record by Range-fetching the
 *  zip's tail. Returns the central-directory byte offset + size. */
async function readEocd(
    bucket: R2Bucket, path: string, totalSize: number,
): Promise<{ cdOffset: number; cdSize: number; entryCount: number }> {
    if (totalSize < EOCD_MIN) throw new HttpError(400, `not a zip: ${path}`)
    const tailLen = Math.min(EOCD_MAX, totalSize)
    const tailObj = await bucket.get(path, {
        range: { offset: totalSize - tailLen, length: tailLen },
    })
    if (!tailObj) throw new HttpError(404, `tail read failed: ${path}`)
    const tail = new Uint8Array(await tailObj.arrayBuffer())
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

    // Scan from the end for the EOCD signature.
    let eocdAt = -1
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIG) { eocdAt = i; break }
    }
    if (eocdAt < 0) throw new HttpError(400, `no EOCD signature: ${path}`)

    let entryCount = view.getUint16(eocdAt + 10, true)
    let cdSize = view.getUint32(eocdAt + 12, true)
    let cdOffset = view.getUint32(eocdAt + 16, true)

    // ZIP64: if any of those fields are 0xffff/0xffffffff, the real
    // values live in a Zip64 EOCD record before the regular one.
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        // Find Zip64 locator (20 bytes) just before the EOCD.
        const locAt = eocdAt - 20
        if (locAt >= 0 && view.getUint32(locAt, true) === ZIP64_LOCATOR_SIG) {
            const z64Offset = Number(view.getBigUint64(locAt + 8, true))
            const z64Obj = await bucket.get(path, {
                range: { offset: z64Offset, length: 56 },
            })
            if (z64Obj) {
                const z64 = new Uint8Array(await z64Obj.arrayBuffer())
                const zv = new DataView(z64.buffer, z64.byteOffset, z64.byteLength)
                entryCount = Number(zv.getBigUint64(32, true))
                cdSize = Number(zv.getBigUint64(40, true))
                cdOffset = Number(zv.getBigUint64(48, true))
            }
        }
    }

    return { cdOffset, cdSize, entryCount }
}

function dosTimeToIso(date: number, time: number): string | undefined {
    const day = date & 0x1f
    const month = (date >> 5) & 0x0f
    const year = ((date >> 9) & 0x7f) + 1980
    const sec = (time & 0x1f) * 2
    const min = (time >> 5) & 0x3f
    const hr = (time >> 11) & 0x1f
    if (year < 1980 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${year}-${pad(month)}-${pad(day)}T${pad(hr)}:${pad(min)}:${pad(sec)}`
}

export async function handleZipEntries(
    bucket: R2Bucket, url: URL,
): Promise<ZipEntriesResponse> {
    const path = normalizeRawPath(url.searchParams.get("path"), "path")
    if (!path.toLowerCase().endsWith(".zip")) {
        throw new HttpError(400, "path must end with .zip")
    }

    const head = await bucket.head(path)
    if (!head) throw new HttpError(404, `not found: ${path}`)

    const { cdOffset, cdSize } = await readEocd(bucket, path, head.size)

    const cdObj = await bucket.get(path, { range: { offset: cdOffset, length: cdSize } })
    if (!cdObj) throw new HttpError(500, `failed to read central directory`)
    const cd = new Uint8Array(await cdObj.arrayBuffer())
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)

    const decoder = new TextDecoder()
    const entries: ZipEntry[] = []
    let totalSize = 0
    let totalCompressed = 0
    let p = 0
    while (p + 46 <= cd.length) {
        if (cv.getUint32(p, true) !== CD_ENTRY_SIG) break
        const method = cv.getUint16(p + 10, true)
        const modTime = cv.getUint16(p + 12, true)
        const modDate = cv.getUint16(p + 14, true)
        const crc32 = cv.getUint32(p + 16, true)
        let csize = cv.getUint32(p + 20, true)
        let usize = cv.getUint32(p + 24, true)
        const nameLen = cv.getUint16(p + 28, true)
        const extraLen = cv.getUint16(p + 30, true)
        const commentLen = cv.getUint16(p + 32, true)
        let offset = cv.getUint32(p + 42, true)
        const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen))

        // Zip64 extras: if any of csize/usize/offset is 0xffffffff,
        // the real value lives in the extra field with header 0x0001.
        if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
            const extraStart = p + 46 + nameLen
            let q = extraStart
            const extraEnd = extraStart + extraLen
            while (q + 4 <= extraEnd) {
                const tag = cv.getUint16(q, true)
                const len = cv.getUint16(q + 2, true)
                if (tag === 0x0001) {
                    let r = q + 4
                    if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(r, true)); r += 8 }
                    if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(r, true)); r += 8 }
                    if (offset === 0xffffffff) { offset = Number(cv.getBigUint64(r, true)); r += 8 }
                    break
                }
                q += 4 + len
            }
        }

        // Skip directory entries (name ending in `/`, size 0)
        if (!name.endsWith("/")) {
            entries.push({
                name,
                size: usize,
                compressedSize: csize,
                offset,
                method,
                crc32,
                lastModified: dosTimeToIso(modDate, modTime),
            })
            totalSize += usize
            totalCompressed += csize
        }

        p += 46 + nameLen + extraLen + commentLen
    }

    return { entries, totalSize, totalCompressed }
}

/** ---------- /v1/raw/zip-entry ---------- */

const LFH_SIG = 0x04034b50

/** Inflate (or pass through) a single zip entry from the underlying
 *  R2 object. Reads the 30-byte local file header to get the actual
 *  data start (LFH has its own name+extra lengths, possibly different
 *  from the central directory's), then range-fetches the compressed
 *  bytes and decompresses. */
export async function handleZipEntry(
    bucket: R2Bucket, url: URL,
): Promise<Response> {
    const path = normalizeRawPath(url.searchParams.get("path"), "path")
    const entry = url.searchParams.get("entry")
    const offsetStr = url.searchParams.get("offset")
    const csizeStr = url.searchParams.get("csize")
    const methodStr = url.searchParams.get("method") ?? "8"
    if (!entry) throw new HttpError(400, "entry is required")
    if (!offsetStr || !csizeStr) throw new HttpError(400, "offset and csize are required")
    const offset = parseInt(offsetStr, 10)
    const csize = parseInt(csizeStr, 10)
    const method = parseInt(methodStr, 10)
    if (!Number.isFinite(offset) || !Number.isFinite(csize)) {
        throw new HttpError(400, "offset and csize must be integers")
    }

    // Read 30-byte LFH to get name/extra lengths.
    const lfhObj = await bucket.get(path, { range: { offset, length: 30 } })
    if (!lfhObj) throw new HttpError(404, `LFH read failed: ${path}`)
    const lfh = new Uint8Array(await lfhObj.arrayBuffer())
    const lv = new DataView(lfh.buffer, lfh.byteOffset, lfh.byteLength)
    if (lv.getUint32(0, true) !== LFH_SIG) {
        throw new HttpError(400, `not a local file header at offset ${offset}`)
    }
    const nameLen = lv.getUint16(26, true)
    const extraLen = lv.getUint16(28, true)
    const dataStart = offset + 30 + nameLen + extraLen

    // Range-fetch compressed bytes.
    const dataObj = await bucket.get(path, { range: { offset: dataStart, length: csize } })
    if (!dataObj) throw new HttpError(404, `entry data read failed`)
    const compressed = new Uint8Array(await dataObj.arrayBuffer())

    let body: Uint8Array
    if (method === 0) {
        body = compressed
    } else if (method === 8) {
        // Synchronous inflate (fflate is small and fast). Workers
        // limits us to ~128 MB heap; NJDOT zips are ≤50 MB, fine.
        body = inflateSync(compressed)
    } else {
        throw new HttpError(400, `unsupported compression method: ${method}`)
    }

    const headers: Record<string, string> = {
        "Content-Type": contentTypeFor(entry),
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Zip-Source": path,
        "X-Zip-Entry": entry,
    }
    return new Response(body, { status: 200, headers })
}
