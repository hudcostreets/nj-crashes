import { useEffect, useState } from "react"
import { parquetRead, parquetMetadataAsync, parquetSchema, asyncBufferFromUrl } from "hyparquet"
import { rawGetUrl, fmtSize } from "./api"

type Schema = { name: string; type?: string }[]

const ROWS_PER_PAGE = 200

/** Hyparquet-backed table viewer. Reads metadata via Range requests
 *  (parquet footer at end of file) so we can show the schema before
 *  loading any row groups. Then loads `ROWS_PER_PAGE` rows at a time.
 *
 *  Note: hyparquet's `parquetRead` reads a contiguous row range; we
 *  pass `rowStart`/`rowEnd` to fetch only the visible page. Each page
 *  is a fresh read (no cross-page caching beyond the browser's HTTP
 *  cache on the worker's range responses). */
export function ParquetTable({ path }: { path: string }) {
    const [schema, setSchema] = useState<Schema | null>(null)
    const [totalRows, setTotalRows] = useState<number | null>(null)
    const [byteSize, setByteSize] = useState<number | null>(null)
    const [page, setPage] = useState(0)
    const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    const url = rawGetUrl(path)

    useEffect(() => {
        let cancelled = false
        setSchema(null); setTotalRows(null); setByteSize(null); setPage(0); setRows(null); setError(null)
        async function load() {
            try {
                const file = await asyncBufferFromUrl({ url })
                const meta = await parquetMetadataAsync(file)
                if (cancelled) return
                const sch = parquetSchema(meta).children.map((c: { element: { name: string; type?: string } }) => ({
                    name: c.element.name,
                    type: c.element.type ? String(c.element.type) : undefined,
                }))
                setSchema(sch)
                setTotalRows(Number(meta.num_rows))
                if ("byteLength" in file) setByteSize(Number((file as { byteLength: number }).byteLength))
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        }
        load()
        return () => { cancelled = true }
    }, [url])

    useEffect(() => {
        if (totalRows === null) return
        let cancelled = false
        const rowStart = page * ROWS_PER_PAGE
        const rowEnd = Math.min(totalRows, rowStart + ROWS_PER_PAGE)
        async function loadPage() {
            try {
                const file = await asyncBufferFromUrl({ url })
                const out: Record<string, unknown>[] = []
                await parquetRead({
                    file,
                    rowStart, rowEnd,
                    rowFormat: "object",
                    onComplete: (data: unknown) => {
                        if (Array.isArray(data)) for (const r of data) out.push(r as Record<string, unknown>)
                    },
                })
                if (!cancelled) setRows(out)
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        }
        loadPage()
        return () => { cancelled = true }
    }, [url, page, totalRows])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!schema || totalRows === null) return <div style={{ opacity: 0.6 }}>reading parquet metadata…</div>

    const pages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE))
    const rowStart = page * ROWS_PER_PAGE
    const rowEnd = Math.min(totalRows, rowStart + ROWS_PER_PAGE)

    return (
        <>
            <p style={{ opacity: 0.7, fontSize: "0.95em" }}>
                <b>{totalRows.toLocaleString()}</b> rows · <b>{schema.length}</b> columns
                {byteSize ? <> · {fmtSize(byteSize)}</> : null}
            </p>

            <details style={{ marginBottom: "0.5em" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.9em", opacity: 0.8 }}>schema</summary>
                <table style={{ borderCollapse: "collapse", marginTop: "0.3em", fontSize: "0.85em" }}>
                    <tbody>
                        {schema.map(c => (
                            <tr key={c.name}>
                                <td style={{ padding: "0.1em 0.6em 0.1em 0", fontFamily: "ui-monospace, monospace" }}>{c.name}</td>
                                <td style={{ padding: "0.1em 0", opacity: 0.7 }}>{c.type ?? "?"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>

            <div style={{ display: "flex", gap: "0.5em", alignItems: "center", marginBottom: "0.5em", fontSize: "0.9em", opacity: 0.85 }}>
                <button disabled={page === 0} onClick={() => setPage(0)}>« first</button>
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹ prev</button>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    page <b>{page + 1}</b> / {pages} · rows {rowStart.toLocaleString()}–{rowEnd.toLocaleString()} / {totalRows.toLocaleString()}
                </span>
                <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>next ›</button>
                <button disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>last »</button>
            </div>

            <div style={{ overflowX: "auto", maxHeight: "70vh", overflowY: "auto", border: "1px solid rgba(127,127,127,0.3)", borderRadius: 4 }}>
                <table style={{ borderCollapse: "collapse", fontSize: "0.82em", fontFamily: "ui-monospace, monospace" }}>
                    <thead>
                        <tr style={{ position: "sticky", top: 0, background: "var(--bg, #181818)" }}>
                            {schema.map(c => (
                                <th key={c.name} style={{ padding: "0.3em 0.6em", textAlign: "left", borderBottom: "1px solid rgba(127,127,127,0.4)", fontWeight: 500 }}>
                                    {c.name}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows === null ? (
                            <tr><td colSpan={schema.length} style={{ padding: "0.5em", opacity: 0.6 }}>loading…</td></tr>
                        ) : (
                            rows.map((r, i) => (
                                <tr key={i} style={{ borderTop: "1px solid rgba(127,127,127,0.15)" }}>
                                    {schema.map(c => (
                                        <td key={c.name} style={{ padding: "0.2em 0.6em", whiteSpace: "nowrap", maxWidth: "30em", overflow: "hidden", textOverflow: "ellipsis" }}>
                                            {fmt(r[c.name])}
                                        </td>
                                    ))}
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </>
    )
}

function fmt(v: unknown): string {
    if (v === null || v === undefined) return ""
    if (typeof v === "bigint") return v.toString()
    if (v instanceof Date) return v.toISOString()
    if (typeof v === "object") return JSON.stringify(v)
    return String(v)
}
