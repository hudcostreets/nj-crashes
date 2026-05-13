import { Link } from "react-router-dom"

export type Crumb = { label: string; href?: string }

/** Path-style breadcrumb: `raw / njdot / data / 2023 / X.zip / X.txt`.
 *  Last crumb has no `href` (current location). When `downloadUrl` is
 *  provided (viewing a file, not a directory), append a download icon
 *  pointing at the raw bytes. Matches the affordance `@rdub/file-tree`
 *  surfaces on `/files/*` via the `Store.getUrl` capability. */
export function Breadcrumb({ crumbs, downloadUrl }: { crumbs: Crumb[]; downloadUrl?: string }) {
    return (
        <nav style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.95em",
            marginBottom: "0.5em",
            wordBreak: "break-all",
        }}>
            {crumbs.map((c, i) => (
                <span key={i}>
                    {i > 0 && <span style={{ opacity: 0.5, margin: "0 0.3em" }}>/</span>}
                    {c.href ? <Link to={c.href}>{c.label}</Link> : <b>{c.label}</b>}
                </span>
            ))}
            {downloadUrl && (
                <a
                    href={downloadUrl}
                    download
                    title="Download file"
                    style={{ marginLeft: "0.5em", textDecoration: "none", opacity: 0.7 }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={e => (e.currentTarget.style.opacity = "0.7")}
                >
                    ⬇
                </a>
            )}
        </nav>
    )
}
