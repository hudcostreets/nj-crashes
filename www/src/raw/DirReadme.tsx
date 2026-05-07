/** Renders `<prefix>README.md` above a directory listing. Silent on
 *  404 — most leaf dirs don't have one. See
 *  `specs/raw-browser-readme-rendering.md`.
 */
import { useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { rawGetUrl } from "./api"

export function DirReadme({ prefix }: { prefix: string }) {
    const [text, setText] = useState<string | null>(null)
    const url = rawGetUrl(`${prefix}README.md`)

    useEffect(() => {
        let cancelled = false
        setText(null)
        fetch(url)
            .then(r => {
                if (cancelled) return null
                if (r.status === 404) return null
                if (!r.ok) throw new Error(`README fetch failed: ${r.status}`)
                return r.text()
            })
            .then(t => { if (!cancelled && t) setText(t) })
            .catch(() => { /* silent */ })
        return () => { cancelled = true }
    }, [url])

    if (!text) return null
    return (
        <div style={{
            maxWidth: 800, marginBottom: "1em", paddingBottom: "1em",
            borderBottom: "1px solid rgba(127,127,127,0.25)",
            lineHeight: 1.55,
        }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    )
}
