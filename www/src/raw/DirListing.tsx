import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useUrlState, defStringParam } from "use-prms"
import { fetchList, fmtSize, basename, type ListEntry } from "./api"
import { DirReadme } from "./DirReadme"
import { makeMatcher } from "./match"

/** Directory listing under the given R2 prefix (must start with
 *  `raw/`). Renders as a simple table; clicking an entry navigates to
 *  `/raw/<key>` (or `/raw/<key>/` for dirs).
 *
 *  Filter: `?q=` applies a substring match (case-insensitive) by
 *  default; if the value contains `*` or `?`, treats it as an
 *  anchored glob (`NewJersey*` matches `NewJersey2022Drivers.zip`). */
export function DirListing({ prefix }: { prefix: string }) {
    const [entries, setEntries] = useState<ListEntry[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [cursor, setCursor] = useState<string | undefined>(undefined)
    const [q, setQ] = useUrlState("q", defStringParam(""))

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

    const matcher = useMemo(() => makeMatcher(q), [q])
    const filtered = useMemo(() => {
        if (!entries) return null
        if (!q) return entries
        return entries.filter(e => matcher(basename(e.key)))
    }, [entries, q, matcher])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!entries || !filtered) return <div style={{ opacity: 0.6 }}>loading {prefix}…</div>

    const filterUI = (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5em", marginBottom: "0.5em", fontSize: "0.9em" }}>
            <input
                type="search"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="filter (e.g. NewJersey* or pedestr)"
                style={{
                    padding: "0.3em 0.6em",
                    borderRadius: 4,
                    border: "1px solid rgba(127,127,127,0.4)",
                    background: "rgba(127,127,127,0.08)",
                    color: "inherit",
                    fontFamily: "ui-monospace, monospace",
                    minWidth: "20em",
                }}
            />
            <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
                {q ? <>{filtered.length} / {entries.length}</> : <>{entries.length} entries</>}
            </span>
            {q && (
                <button onClick={() => setQ("")} style={{ fontSize: "0.85em", padding: "0.2em 0.6em" }}>
                    clear
                </button>
            )}
        </div>
    )

    if (filtered.length === 0) {
        return (
            <>
                <DirReadme prefix={prefix} />
                {filterUI}
                <div style={{ opacity: 0.6 }}>
                    {q ? <>no entries match <code>{q}</code></> : <>empty: <code>{prefix}</code></>}
                </div>
            </>
        )
    }

    return (
        <>
            <DirReadme prefix={prefix} />
            {filterUI}
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                    <tr style={{ textAlign: "left", opacity: 0.7 }}>
                        <th style={{ padding: "0.2em 0.6em 0.2em 0", fontWeight: 400 }}>name</th>
                        <th style={{ padding: "0.2em 0.6em", fontWeight: 400, textAlign: "right" }}>size</th>
                        <th style={{ padding: "0.2em 0", fontWeight: 400, textAlign: "right" }}>modified</th>
                    </tr>
                </thead>
                <tbody>
                    {filtered.map(e => {
                        const name = basename(e.key)
                        // R2 keys carry the `raw/` prefix; URL splat is the part *after* `/raw/`.
                        const href = `/raw/${e.key.replace(/^raw\//, "")}`
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
