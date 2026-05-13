/** Minimal SQL REPL backed by DuckDB-WASM.
 *
 *  Query params:
 *    ?path=raw/njdot/...   — pre-fill with `SELECT * FROM read_parquet('<worker-url>') LIMIT 100`
 *    ?q=<sql>              — pre-fill with arbitrary SQL (URL-encoded)
 *
 *  Both params are bookmarkable / shareable; `?path` is what the
 *  parquet preview in `/raw/...` deeplinks to.
 */
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useUrlState, defStringParam, stringParam } from "use-prms"
import { Head } from "@/src/lib/head"
import { useDb, runQuery } from "@/src/lib/DuckDbContext"
import { rawGetUrl } from "@/src/raw/api"

type Row = Record<string, unknown>

function defaultQueryFor(path: string | undefined): string {
    if (!path) return "SELECT 'hello' AS greeting;"
    return `SELECT * FROM read_parquet('${rawGetUrl(path)}') LIMIT 100;`
}

function fmt(v: unknown): string {
    if (v === null || v === undefined) return ""
    if (typeof v === "bigint") return v.toString()
    if (v instanceof Date) return v.toISOString()
    if (typeof v === "object") return JSON.stringify(v)
    return String(v)
}

export default function SqlPage() {
    const db = useDb()
    const [path] = useUrlState("path", stringParam())
    const [q, setQ] = useUrlState("q", defStringParam(""))
    const initialQuery = useMemo(() => q || defaultQueryFor(path), [])  // first render only

    const [draft, setDraft] = useState<string>(initialQuery)
    const [rows, setRows] = useState<Row[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [running, setRunning] = useState(false)
    const [elapsed, setElapsed] = useState<number | null>(null)

    // If `?path` changes (and `?q` is empty), update the draft to reflect it.
    useEffect(() => {
        if (q) return
        setDraft(defaultQueryFor(path))
    }, [path, q])

    async function run() {
        if (!db) return
        setRunning(true)
        setError(null)
        const t0 = performance.now()
        try {
            const result = await runQuery<Row>(db, draft)
            setRows(result)
            setElapsed(performance.now() - t0)
            setQ(draft)  // share-link reflects the actual query that ran
        } catch (e) {
            setError(String(e))
            setRows(null)
            setElapsed(null)
        } finally {
            setRunning(false)
        }
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            run()
        }
    }

    const cols = rows && rows.length > 0 ? Object.keys(rows[0]) : []

    return (
        <div style={{
            maxWidth: 1200, margin: "0 auto", padding: "1em 1.5em",
            fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
            <Head title="SQL — NJ Crashes"
                description="DuckDB-WASM SQL REPL over the NJ crash data archive." />
            <h1 style={{ fontSize: "1.4em", margin: "0 0 0.3em" }}>SQL</h1>
            <p style={{ fontSize: "0.9em", opacity: 0.7, margin: "0 0 0.5em" }}>
                DuckDB-WASM REPL.{" "}
                {path && <>Connected to <Link to={`/raw/${path.replace(/^raw\//, "")}`}><code>{path}</code></Link>.{" "}</>}
                Cmd/Ctrl-Enter to run.
            </p>

            <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                style={{
                    width: "100%", minHeight: "8em", padding: "0.6em 0.8em",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: "0.9em", lineHeight: 1.4,
                    background: "rgba(127,127,127,0.08)",
                    color: "inherit",
                    border: "1px solid rgba(127,127,127,0.3)",
                    borderRadius: 4, resize: "vertical",
                }}
            />
            <div style={{ display: "flex", gap: "0.5em", alignItems: "center", margin: "0.5em 0" }}>
                <button
                    onClick={run}
                    disabled={!db || running}
                    style={{
                        padding: "0.4em 1em",
                        background: db ? "#0066cc" : "rgba(127,127,127,0.2)",
                        color: db ? "white" : "inherit",
                        border: "1px solid rgba(127,127,127,0.4)",
                        borderRadius: 4,
                        cursor: db && !running ? "pointer" : "default",
                        fontFamily: "inherit",
                    }}
                >
                    {running ? "Running…" : !db ? "Loading DuckDB…" : "Run"}
                </button>
                {elapsed !== null && (
                    <span style={{ fontSize: "0.85em", opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
                        {rows?.length.toLocaleString() ?? 0} row{rows?.length === 1 ? "" : "s"} in {elapsed.toFixed(0)} ms
                    </span>
                )}
            </div>

            {error && (
                <pre style={{
                    color: "salmon", background: "rgba(255,100,100,0.08)",
                    padding: "0.5em 0.8em", borderRadius: 4,
                    whiteSpace: "pre-wrap", fontSize: "0.85em",
                }}>
                    {error}
                </pre>
            )}

            {rows !== null && !error && (
                <div style={{
                    overflowX: "auto", maxHeight: "70vh", overflowY: "auto",
                    border: "1px solid rgba(127,127,127,0.3)", borderRadius: 4,
                }}>
                    <table style={{
                        borderCollapse: "collapse", fontSize: "0.82em",
                        fontFamily: "ui-monospace, monospace",
                    }}>
                        <thead>
                            <tr style={{ position: "sticky", top: 0, background: "var(--bg, #181818)" }}>
                                {cols.map(c => (
                                    <th key={c} style={{
                                        padding: "0.3em 0.6em", textAlign: "left",
                                        borderBottom: "1px solid rgba(127,127,127,0.4)",
                                        fontWeight: 500,
                                    }}>
                                        {c}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr><td colSpan={Math.max(1, cols.length)} style={{ padding: "0.5em", opacity: 0.6 }}>
                                    (no rows)
                                </td></tr>
                            ) : (
                                rows.map((r, i) => (
                                    <tr key={i} style={{ borderTop: "1px solid rgba(127,127,127,0.15)" }}>
                                        {cols.map(c => (
                                            <td key={c} style={{
                                                padding: "0.2em 0.6em", whiteSpace: "nowrap",
                                                maxWidth: "30em", overflow: "hidden", textOverflow: "ellipsis",
                                            }}>
                                                {fmt(r[c])}
                                            </td>
                                        ))}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}
