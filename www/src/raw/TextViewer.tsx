import { useEffect, useState } from "react"
import { fmtSize, fetchSize, rangeFetch } from "./api"

const PAGE_BYTES = 256 * 1024  // 256 KB per page — typical NJDOT .txt has ~250-byte rows so ~1000 lines/page

/** Range-paginated text viewer.
 *
 *  Fetches `PAGE_BYTES` at a time via `/v1/raw/get` with a `Range:` header.
 *  Bytes (not lines) are the addressable unit — line-aware pagination
 *  would need to scan the file to find newline offsets, which is a
 *  premature optimization for the demo. We trim the partial first/last
 *  line of each page based on whether we're at the file boundary.
 *
 *  Source can be either:
 *    - `path: "raw/njdot/.../X.txt"` — direct R2 object, or
 *    - a (`url`, `total`) pair pointing at a zip-entry endpoint already
 *      resolved by the caller (zip entries don't support Range yet).
 */
export type TextSource =
    | { kind: "raw"; path: string }
    | { kind: "url"; url: string; total: number }

export function TextViewer({ source }: { source: TextSource }) {
    const [total, setTotal] = useState<number | null>(
        source.kind === "url" ? source.total : null
    )
    const [page, setPage] = useState(0)
    const [text, setText] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    // Reset on source change.
    useEffect(() => {
        let cancelled = false
        setPage(0)
        setText(null)
        setError(null)
        setTotal(source.kind === "url" ? source.total : null)
        if (source.kind === "raw") {
            fetchSize(source.path)
                .then(s => { if (!cancelled) setTotal(s) })
                .catch(e => { if (!cancelled) setError(String(e)) })
        }
        return () => { cancelled = true }
    }, [source.kind === "raw" ? source.path : source.url])

    useEffect(() => {
        if (total === null) return
        let cancelled = false
        const offset = page * PAGE_BYTES
        const length = Math.min(PAGE_BYTES, total - offset)
        if (length <= 0) { setText(""); return }

        async function load() {
            try {
                if (source.kind === "raw") {
                    const { bytes } = await rangeFetch(source.path, offset, length)
                    if (cancelled) return
                    setText(decodeAndTrim(bytes, page > 0, offset + length < total!))
                } else {
                    // zip-entry: no range support yet → fetch entire entry once
                    // and slice in JS.
                    const res = await fetch(source.url)
                    if (!res.ok) throw new Error(`${res.status}`)
                    const buf = new Uint8Array(await res.arrayBuffer())
                    if (cancelled) return
                    const slice = buf.subarray(offset, offset + length)
                    setText(decodeAndTrim(slice, page > 0, offset + length < total!))
                }
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        }
        load()
        return () => { cancelled = true }
    }, [page, total, source.kind === "raw" ? source.path : source.url])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (total === null) return <div style={{ opacity: 0.6 }}>loading…</div>

    const pages = Math.max(1, Math.ceil(total / PAGE_BYTES))
    const offset = page * PAGE_BYTES
    const end = Math.min(total, offset + PAGE_BYTES)

    return (
        <>
            <div style={{ display: "flex", gap: "0.5em", alignItems: "center", marginBottom: "0.5em", fontSize: "0.9em", opacity: 0.85 }}>
                <button disabled={page === 0} onClick={() => setPage(0)}>« first</button>
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹ prev</button>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    page <b>{page + 1}</b> / {pages} · bytes {fmtSize(offset)}–{fmtSize(end)} / {fmtSize(total)}
                </span>
                <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>next ›</button>
                <button disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>last »</button>
                <input
                    type="number" min={1} max={pages}
                    value={page + 1}
                    onChange={e => {
                        const v = parseInt(e.target.value, 10)
                        if (Number.isFinite(v) && v >= 1 && v <= pages) setPage(v - 1)
                    }}
                    style={{ width: "5em", marginLeft: "auto" }}
                />
            </div>
            <pre style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.82em",
                whiteSpace: "pre",
                overflowX: "auto",
                background: "rgba(127,127,127,0.08)",
                padding: "0.5em",
                borderRadius: 4,
                margin: 0,
                maxHeight: "70vh",
                overflowY: "auto",
            }}>
                {text === null ? "loading…" : text}
            </pre>
        </>
    )
}

/** Drop the partial first line if `trimStart` (we landed mid-line) and
 *  the partial last line if `trimEnd` (next page picks it up). */
function decodeAndTrim(bytes: Uint8Array, trimStart: boolean, trimEnd: boolean): string {
    let s = new TextDecoder().decode(bytes)
    if (trimStart) {
        const i = s.indexOf("\n")
        if (i >= 0) s = s.slice(i + 1)
    }
    if (trimEnd) {
        const i = s.lastIndexOf("\n")
        if (i >= 0) s = s.slice(0, i + 1)
    }
    return s
}
