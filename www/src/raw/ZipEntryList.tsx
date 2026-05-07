import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { fetchZipEntries, fmtSize, type ZipEntry } from "./api"

/** List the entries of a zip at `<path>`. Clicking an entry navigates
 *  to `/raw/<path>!/<entry>`. */
export function ZipEntryList({ path }: { path: string }) {
    const [resp, setResp] = useState<{ entries: ZipEntry[]; totalSize: number; totalCompressed: number } | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setResp(null); setError(null)
        fetchZipEntries(path).then(r => {
            if (!cancelled) setResp(r)
        }).catch(e => {
            if (!cancelled) setError(String(e))
        })
        return () => { cancelled = true }
    }, [path])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!resp) return <div style={{ opacity: 0.6 }}>reading central directory of {path}…</div>

    return (
        <>
            <p style={{ opacity: 0.7, fontSize: "0.95em" }}>
                <b>{resp.entries.length}</b> entries · uncompressed{" "}
                <b>{fmtSize(resp.totalSize)}</b> · compressed{" "}
                <b>{fmtSize(resp.totalCompressed)}</b>
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                    <tr style={{ textAlign: "left", opacity: 0.7 }}>
                        <th style={{ padding: "0.2em 0.6em 0.2em 0", fontWeight: 400 }}>name</th>
                        <th style={{ padding: "0.2em 0.6em", fontWeight: 400, textAlign: "right" }}>size</th>
                        <th style={{ padding: "0.2em 0.6em", fontWeight: 400, textAlign: "right" }}>compressed</th>
                        <th style={{ padding: "0.2em 0", fontWeight: 400, textAlign: "right" }}>method</th>
                    </tr>
                </thead>
                <tbody>
                    {resp.entries.map(e => {
                        const href = `/raw/${path}!/${e.name}`
                        const methodLabel = e.method === 0 ? "store" : e.method === 8 ? "deflate" : `m${e.method}`
                        return (
                            <tr key={e.name} style={{ borderTop: "1px solid rgba(127,127,127,0.2)" }}>
                                <td style={{ padding: "0.3em 0.6em 0.3em 0", fontFamily: "ui-monospace, monospace" }}>
                                    <Link to={href}>{e.name}</Link>
                                </td>
                                <td style={{ padding: "0.3em 0.6em", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                    {fmtSize(e.size)}
                                </td>
                                <td style={{ padding: "0.3em 0.6em", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: 0.7 }}>
                                    {fmtSize(e.compressedSize)}
                                </td>
                                <td style={{ padding: "0.3em 0", textAlign: "right", opacity: 0.7, fontSize: "0.9em" }}>
                                    {methodLabel}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </>
    )
}
