import { Link } from "react-router-dom"

export type Crumb = { label: string; href?: string }

/** Path-style breadcrumb: `raw / njdot / data / 2023 / X.zip / X.txt`.
 *  Last crumb has no `href` (current location). */
export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
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
        </nav>
    )
}
