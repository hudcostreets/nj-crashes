import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { fetchList, fmtSize, basename, type ListEntry } from "./api"

/** Directory listing under the given R2 prefix (must start with
 *  `raw/`). Renders as a simple table; clicking an entry navigates to
 *  `/raw/<key>` (or `/raw/<key>/` for dirs). */
export function DirListing({ prefix }: { prefix: string }) {
    const [entries, setEntries] = useState<ListEntry[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [cursor, setCursor] = useState<string | undefined>(undefined)

    useEffect(() => {
        let cancelled = false
        setEntries(null); setError(null); setCursor(undefined)
        fetchList(prefix).then(r => {
            if (cancelled) return
            setEntries(r.entries)
            setCursor(r.cursor)
        }).catch(e => {
            if (cancelled) return
            setError(String(e))
        })
        return () => { cancelled = true }
    }, [prefix])

    async function loadMore() {
        if (!cursor) return
        const r = await fetchList(prefix, cursor)
        setEntries(prev => [...(prev ?? []), ...r.entries])
        setCursor(r.cursor)
    }

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!entries) return <div style={{ opacity: 0.6 }}>loading {prefix}…</div>
    if (entries.length === 0) {
        return (
            <div style={{ opacity: 0.6 }}>
                empty: <code>{prefix}</code>
            </div>
        )
    }

    return (
        <>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                    <tr style={{ textAlign: "left", opacity: 0.7 }}>
                        <th style={{ padding: "0.2em 0.6em 0.2em 0", fontWeight: 400 }}>name</th>
                        <th style={{ padding: "0.2em 0.6em", fontWeight: 400, textAlign: "right" }}>size</th>
                        <th style={{ padding: "0.2em 0", fontWeight: 400, textAlign: "right" }}>modified</th>
                    </tr>
                </thead>
                <tbody>
                    {entries.map(e => {
                        const name = basename(e.key)
                        // Dirs come back with trailing `/`; files don't.
                        const href = `/raw/${e.key}`
                        return (
                            <tr key={e.key} style={{ borderTop: "1px solid rgba(127,127,127,0.2)" }}>
                                <td style={{ padding: "0.3em 0.6em 0.3em 0", fontFamily: "ui-monospace, monospace" }}>
                                    <Link to={href}>
                                        {e.isDir ? <span style={{ opacity: 0.6 }}>📁 </span> : null}
                                        {name}{e.isDir ? "/" : ""}
                                    </Link>
                                </td>
                                <td style={{ padding: "0.3em 0.6em", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: e.isDir ? 0.4 : 1 }}>
                                    {e.isDir ? "—" : fmtSize(e.size)}
                                </td>
                                <td style={{ padding: "0.3em 0", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: 0.6, fontSize: "0.9em" }}>
                                    {e.lastModified?.slice(0, 10) ?? ""}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
            {cursor && (
                <button onClick={loadMore} style={{ marginTop: "0.5em" }}>
                    load more
                </button>
            )}
        </>
    )
}
