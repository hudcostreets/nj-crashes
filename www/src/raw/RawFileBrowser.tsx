/** `/raw/*` file-browser route.
 *
 *  Splat structure:
 *    /raw/                                    → list `raw/`
 *    /raw/njdot/data/2023/                    → list `raw/njdot/data/2023/`
 *    /raw/njdot/data/2022/X.zip               → zip entry list
 *    /raw/njdot/data/2022/X.zip!/X.txt        → zip entry preview
 *    /raw/njdot/data/2022/X.txt               → text viewer (Range)
 *    /raw/njdot/data/2022/X.pqt               → parquet table
 *
 *  R2 keys all live under the `raw/` prefix; the URL splat after `/raw/`
 *  is appended verbatim to that prefix. We don't strip or rewrite the
 *  `!/<entry>` separator on the worker side — it's split client-side.
 */
import { useMemo } from "react"
import { useLocation } from "react-router-dom"
import { Head } from "../lib/head"
import { Breadcrumb, type Crumb } from "./Breadcrumb"
import { DirListing } from "./DirListing"
import { ZipEntryList } from "./ZipEntryList"
import { TextViewer, type TextSource } from "./TextViewer"
import { ParquetTable } from "./ParquetTable"
import { extOf, rawZipEntryUrl, fetchZipEntries } from "./api"
import { useEffect, useState } from "react"

const RAW_PREFIX = "raw/"
const TEXTY = new Set(["txt", "csv", "tsv", "json", "md", "log"])

type Parsed =
    | { kind: "dir"; prefix: string }
    | { kind: "zip"; path: string }
    | { kind: "zipEntry"; path: string; entry: string }
    | { kind: "text"; path: string }
    | { kind: "parquet"; path: string }
    | { kind: "binary"; path: string }

/** Parse URL splat → R2 key + view kind. */
function parsePath(splat: string): Parsed {
    const stripped = splat.replace(/^\/+/, "")  // drop leading slash
    const r2key = RAW_PREFIX + stripped

    // Zip entry: "<zip>!/<entry>"
    const bangIdx = r2key.indexOf("!/")
    if (bangIdx >= 0) {
        return {
            kind: "zipEntry",
            path: r2key.slice(0, bangIdx),
            entry: r2key.slice(bangIdx + 2),
        }
    }

    // Trailing slash → directory (always)
    if (r2key.endsWith("/")) return { kind: "dir", prefix: r2key }

    const ext = extOf(r2key)
    if (ext === "zip") return { kind: "zip", path: r2key }
    if (ext === "pqt" || ext === "parquet") return { kind: "parquet", path: r2key }
    if (TEXTY.has(ext)) return { kind: "text", path: r2key }

    // No extension and no trailing slash: assume directory (DOT users
    // often type `/raw/njdot/data/2023` without the slash).
    if (!ext) return { kind: "dir", prefix: r2key + "/" }

    return { kind: "binary", path: r2key }
}

export default function RawFileBrowser() {
    const location = useLocation()
    // The route is mounted at `/raw/*` so anything after `/raw/` is the splat.
    const splat = location.pathname.replace(/^\/raw\/?/, "")
    const parsed = useMemo(() => parsePath(splat), [splat])
    const crumbs = useMemo(() => buildCrumbs(parsed), [parsed])
    const title = crumbs.length > 0 ? crumbs[crumbs.length - 1].label : "raw"

    return (
        <div style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "1em 1.5em",
            fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
            <Head title={`raw / ${title} — NJ Crashes`} description="Browser over the raw NJDOT bulk crash data archive (Accidents, Drivers, Occupants, Pedestrians, Vehicles)." />
            <h1 style={{ fontSize: "1.4em", margin: "0 0 0.3em" }}>Raw NJDOT data archive</h1>
            <Breadcrumb crumbs={crumbs} />
            <Body parsed={parsed} />
            <Footnote />
        </div>
    )
}

function Body({ parsed }: { parsed: Parsed }) {
    switch (parsed.kind) {
        case "dir":
            return <DirListing prefix={parsed.prefix} />
        case "zip":
            return <ZipEntryList path={parsed.path} />
        case "zipEntry":
            return <ZipEntryPreview path={parsed.path} entry={parsed.entry} />
        case "text": {
            const source: TextSource = { kind: "raw", path: parsed.path }
            return <TextViewer source={source} />
        }
        case "parquet":
            return <ParquetTable path={parsed.path} />
        case "binary":
            return (
                <div style={{ opacity: 0.7 }}>
                    Preview not supported for this file type.{" "}
                    <a href={`/v1/raw/get?path=${encodeURIComponent(parsed.path)}`}>download</a>
                </div>
            )
    }
}

/** Inline preview cap for zip entries. The current zip-entry endpoint
 *  inflates the whole entry into memory worker-side and ships it; for
 *  the 153 MB NJDOT entry tables that overruns the CFW heap. Entries
 *  above this threshold show a download link + a pointer to the .pqt
 *  sibling (which has range-based pagination via parquet metadata). */
const ZIP_ENTRY_PREVIEW_MAX_BYTES = 8 * 1024 * 1024  // 8 MB uncompressed

/** Resolve a zip entry's offset/csize via `/v1/raw/zip-entries`, then
 *  hand off to the appropriate renderer for the entry's extension. */
function ZipEntryPreview({ path, entry }: { path: string; entry: string }) {
    const [resolved, setResolved] = useState<{ url: string; total: number } | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setResolved(null); setError(null)
        fetchZipEntries(path).then(r => {
            if (cancelled) return
            const e = r.entries.find(x => x.name === entry)
            if (!e) { setError(`entry not found: ${entry}`); return }
            setResolved({ url: rawZipEntryUrl(path, e), total: e.size })
        }).catch(e => {
            if (!cancelled) setError(String(e))
        })
        return () => { cancelled = true }
    }, [path, entry])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!resolved) return <div style={{ opacity: 0.6 }}>locating {entry} in {path}…</div>

    const ext = extOf(entry)
    const tooBig = resolved.total > ZIP_ENTRY_PREVIEW_MAX_BYTES
    if (tooBig) {
        // Suggest the .pqt sibling if one exists at the same dir.
        const dir = path.replace(/\/[^/]+$/, "/")
        const stem = path.split("/").pop()!.replace(/\.zip$/, "")
        const pqtPath = `${dir}${stem}.pqt`
        const pqtUrl = `/raw/${pqtPath}`
        return (
            <div style={{ opacity: 0.85, lineHeight: 1.6 }}>
                <p><b>{entry}</b> is {(resolved.total / 1024 / 1024).toFixed(1)} MB uncompressed —
                too large to preview inline.</p>
                <p>Try the parquet sibling instead (range-based pagination, no full
                decompression): <a href={pqtUrl}>{pqtPath}</a>.</p>
                <p>Or <a href={resolved.url}>download the raw entry</a>.</p>
            </div>
        )
    }
    if (TEXTY.has(ext)) {
        const source: TextSource = { kind: "url", url: resolved.url, total: resolved.total }
        return <TextViewer source={source} />
    }
    return (
        <div style={{ opacity: 0.7 }}>
            Inline preview not supported for entries of type <code>.{ext}</code>.{" "}
            <a href={resolved.url}>download</a>
        </div>
    )
}

function buildCrumbs(p: Parsed): Crumb[] {
    let parts: string[] = []
    let entry: string | null = null
    if (p.kind === "dir") {
        parts = p.prefix.replace(/\/$/, "").split("/")
    } else if (p.kind === "zipEntry") {
        parts = p.path.split("/")
        entry = p.entry
    } else {
        parts = (p as { path: string }).path.split("/")
    }
    // Build hrefs incrementally. `raw` is the root.
    const out: Crumb[] = []
    let acc = ""
    for (let i = 0; i < parts.length; i++) {
        acc = i === 0 ? parts[i] : `${acc}/${parts[i]}`
        const isLast = i === parts.length - 1 && entry === null
        const isDir = i < parts.length - 1
        const href = i === 0 ? "/raw/" : `/raw/${acc.slice(RAW_PREFIX.length)}${isDir ? "/" : ""}`
        out.push({ label: parts[i], href: isLast ? undefined : href })
    }
    if (entry !== null) {
        out.push({ label: entry })
    }
    return out
}

function Footnote() {
    return (
        <div style={{
            marginTop: "2em", paddingTop: "1em", borderTop: "1px solid rgba(127,127,127,0.3)",
            fontSize: "0.85em", opacity: 0.7,
        }}>
            <p>
                Browser over the <code>raw/</code> prefix of an R2 mirror of the
                pre-2024 NJDOT bulk crash dumps. Each year has separate
                Accidents / Drivers / Occupants / Pedestrians / Vehicles
                tables that join on a crash case key. The current AASHTO
                dashboard CSV is a single denormalized table —{" "}
                <a href="/raw/njdot/data/2024/" style={{ pointerEvents: "none", opacity: 0.4 }}>not yet
                available in this format for 2024+</a>.
            </p>
        </div>
    )
}
