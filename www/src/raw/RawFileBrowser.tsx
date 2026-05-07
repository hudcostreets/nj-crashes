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
import { extOf, rawZipEntryUrl, rawGetUrl, fetchZipEntries } from "./api"
import { parsePath, RAW_PREFIX, TEXTY, type Parsed } from "./parsePath"
import { useEffect, useState } from "react"

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
        case "pdf":
            return (
                <iframe
                    src={rawGetUrl(parsed.path)}
                    title={parsed.path}
                    style={{ width: "100%", height: "85vh", border: "1px solid rgba(127,127,127,0.3)", borderRadius: 4 }}
                />
            )
        case "binary":
            return (
                <div style={{ opacity: 0.7 }}>
                    Preview not supported for this file type.{" "}
                    <a href={rawGetUrl(parsed.path)}>download</a>
                </div>
            )
    }
}

/** Streaming-preview output cap for zip entries. The worker accepts
 *  `?max=N` and stops inflate once N output bytes are produced —
 *  bounded CPU/memory regardless of the entry's true size. 256 KB is
 *  ~1000 lines of NJDOT fixed-width text, plenty to show the structure. */
const ZIP_ENTRY_STREAMING_PREVIEW_BYTES = 256 * 1024
/** Threshold above which we engage streaming-preview mode (and show
 *  a "previewing first 256 KB of N MB" hint). Below this we fetch the
 *  whole entry (no `max` param) since it's small enough to download
 *  and slice in JS. */
const ZIP_ENTRY_FULL_FETCH_BYTES = 4 * 1024 * 1024  // 4 MB uncompressed

/** Resolve a zip entry's offset/csize via `/v1/raw/zip-entries`, then
 *  hand off to the appropriate renderer for the entry's extension.
 *  Large entries get a streaming-preview (first 256 KB inflated
 *  worker-side) with a banner indicating truncation. */
function ZipEntryPreview({ path, entry }: { path: string; entry: string }) {
    const [resolved, setResolved] = useState<{ url: string; total: number; truncated: boolean } | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setResolved(null); setError(null)
        fetchZipEntries(path).then(r => {
            if (cancelled) return
            const e = r.entries.find(x => x.name === entry)
            if (!e) { setError(`entry not found: ${entry}`); return }
            const truncated = e.size > ZIP_ENTRY_FULL_FETCH_BYTES
            const max = truncated ? ZIP_ENTRY_STREAMING_PREVIEW_BYTES : undefined
            const url = rawZipEntryUrl(path, e, max)
            // For the streaming-preview case the response body length
            // is `max` (or less), not `e.size` — the TextViewer needs
            // to know the actual fetched bytes.
            const total = truncated ? Math.min(e.size, ZIP_ENTRY_STREAMING_PREVIEW_BYTES) : e.size
            setResolved({ url, total, truncated })
        }).catch(e => {
            if (!cancelled) setError(String(e))
        })
        return () => { cancelled = true }
    }, [path, entry])

    if (error) return <div style={{ color: "salmon" }}>error: {error}</div>
    if (!resolved) return <div style={{ opacity: 0.6 }}>locating {entry} in {path}…</div>

    const ext = extOf(entry)
    if (TEXTY.has(ext)) {
        const source: TextSource = { kind: "url", url: resolved.url, total: resolved.total }
        return (
            <>
                {resolved.truncated && <TruncationBanner path={path} entry={entry} previewBytes={resolved.total} />}
                <TextViewer source={source} />
            </>
        )
    }
    return (
        <div style={{ opacity: 0.7 }}>
            Inline preview not supported for entries of type <code>.{ext}</code>.{" "}
            <a href={resolved.url}>download</a>
        </div>
    )
}

function TruncationBanner({ path, entry, previewBytes }: { path: string; entry: string; previewBytes: number }) {
    // Suggest the .pqt sibling if one exists at the same dir.
    const dir = path.replace(/\/[^/]+$/, "/")
    const stem = path.split("/").pop()!.replace(/\.zip$/, "")
    const pqtPath = `${dir}${stem}.pqt`
    return (
        <div style={{
            background: "rgba(220, 165, 60, 0.12)",
            border: "1px solid rgba(220, 165, 60, 0.4)",
            padding: "0.5em 0.8em", borderRadius: 4,
            marginBottom: "0.6em", fontSize: "0.9em",
        }}>
            <b>Streaming preview:</b> showing the first{" "}
            {(previewBytes / 1024).toFixed(0)} KB of <code>{entry}</code>.
            For paginated access, use the parquet sibling{" "}
            <a href={`/raw/${pqtPath.replace(/^raw\//, "")}`}><code>{pqtPath}</code></a>.
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
