import { useEffect, useState } from "react"
import { useUrlState, defStringParam } from "use-prms"
import { rangeFetch, fmtSize } from "./api"
import { Pager } from "./Pager"
import { parseCsvLine } from "./csv"

const PAGE_BYTES = 256 * 1024
const HEADER_PROBE_BYTES = 32 * 1024

/** Range-paginated CSV table viewer. Same byte-pagination model as
 *  `TextViewer` (drop partial first/last lines at chunk boundaries),
 *  but parses the chunk as CSV and renders it as a sticky-header table.
 *
 *  Header is fetched from the start of the file once on mount and
 *  cached for all pages — no per-page header re-fetch. Each page
 *  fetches `PAGE_BYTES` independently; no cross-page caching beyond the
 *  browser's HTTP cache on the worker's range responses.
 *
 *  Accepts `?view=text` URL param to fall back to `TextViewer` (handled
 *  upstream in `RawFileBrowser` — this component only renders the
 *  toggle link). */
export function CsvTable({ path }: { path: string }) {
    const [total, setTotal] = useState<number | null>(null)
    const [header, setHeader] = useState<string[] | null>(null)
    const [page, setPage] = useUrlState("page", defStringParam("0"))
    const [, setView] = useUrlState("view", defStringParam(""))
    const [rows, setRows] = useState<string[][] | null>(null)
    const [error, setError] = useState<string | null>(null)

    const pageNum = Math.max(0, parseInt(page, 10) || 0)

    useEffect(() => {
        let cancelled = false
        setTotal(null); setHeader(null); setRows(null); setError(null)
        async function load() {
            try {
                const probe = await rangeFetch(path, 0, HEADER_PROBE_BYTES)
                if (cancelled) return
                setTotal(probe.total)
                const text = new TextDecoder().decode(probe.bytes)
                const nl = text.indexOf("\n")
                if (nl < 0) throw new Error(`no newline in first ${HEADER_PROBE_BYTES} bytes — not a CSV?`)
                setHeader(parseCsvLine(text.slice(0, nl).replace(/\r$/, "")))
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        }
        load()
        return () => { cancelled = true }
    }, [path])

    useEffect(() => {
        if (total === null || header === null) return
        let cancelled = false
        setRows(null)
        async function loadPage() {
            try {
                const offset = pageNum * PAGE_BYTES
                const length = Math.min(PAGE_BYTES, total! - offset)
                if (length <= 0) { setRows([]); return }
                const { bytes } = await rangeFetch(path, offset, length)
                if (cancelled) return
                const text = new TextDecoder().decode(bytes)
                let lines = text.split("\n")
                // Page 0: drop header line. Other pages: drop partial first line.
                lines = lines.slice(1)
                // Drop partial last line unless we're at EOF.
                const atEof = offset + length >= total!
                if (!atEof && lines.length > 0) lines = lines.slice(0, -1)
                // Trim trailing empty (CSVs commonly end with \n).
                while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
                setRows(lines.map(line => parseCsvLine(line.replace(/\r$/, ""))))
            } catch (e) {
                if (!cancelled) setError(String(e))
            }
        }
        loadPage()
        return () => { cancelled = true }
    }, [path, pageNum, total, header])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (total === null || header === null) return <div style={{ opacity: 0.6 }}>reading CSV header…</div>

    const pages = Math.max(1, Math.ceil(total / PAGE_BYTES))
    const offsetStart = pageNum * PAGE_BYTES
    const offsetEnd = Math.min(total, offsetStart + PAGE_BYTES)

    const setPageNum = (n: number) => setPage(String(n))

    return (
        <>
            <p style={{ opacity: 0.7, fontSize: "0.95em", margin: "0 0 0.6em" }}>
                <b>{header.length}</b> columns · {fmtSize(total)}
                {" · "}
                <a href="#" onClick={e => { e.preventDefault(); setView("text") }}>view as text</a>
            </p>
            <Pager
                page={pageNum} pages={pages} setPage={setPageNum}
                label={<>page <b>{pageNum + 1}</b> / {pages.toLocaleString()} · bytes {offsetStart.toLocaleString()}–{offsetEnd.toLocaleString()} / {total.toLocaleString()}</>}
                jump={false}
            />
            <div style={{ overflowX: "auto", maxHeight: "70vh", overflowY: "auto", border: "1px solid rgba(127,127,127,0.3)", borderRadius: 4 }}>
                <table style={{ borderCollapse: "collapse", fontSize: "0.82em", fontFamily: "ui-monospace, monospace" }}>
                    <thead>
                        <tr style={{ position: "sticky", top: 0, background: "var(--bg, #181818)" }}>
                            {header.map((c, i) => (
                                <th key={i} style={{ padding: "0.3em 0.6em", textAlign: "left", borderBottom: "1px solid rgba(127,127,127,0.4)", fontWeight: 500, whiteSpace: "nowrap" }}>
                                    {c}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows === null ? (
                            <tr><td colSpan={header.length} style={{ padding: "0.5em", opacity: 0.6 }}>loading…</td></tr>
                        ) : (
                            rows.map((r, i) => (
                                <tr key={i} style={{ borderTop: "1px solid rgba(127,127,127,0.15)" }}>
                                    {header.map((_, j) => (
                                        <td key={j} style={{ padding: "0.2em 0.6em", whiteSpace: "nowrap", maxWidth: "30em", overflow: "hidden", textOverflow: "ellipsis" }}>
                                            {r[j] ?? ""}
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
