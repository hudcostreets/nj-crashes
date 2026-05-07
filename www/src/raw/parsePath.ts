/** Parse a `/raw/*` URL splat into a renderable view kind + R2 key.
 *
 *  The splat comes from `location.pathname.replace(/^\/raw\/?/, "")`
 *  so it's percent-encoded. We `decodeURIComponent` the splat before
 *  building the R2 key so entry names with spaces (e.g. "Cape
 *  May2023Pedestrians.txt") round-trip correctly.
 *
 *  Zip entries use the [pkzip-URI convention][1] of `!/` between the
 *  archive path and the entry name (`<zip>!/<entry>`).
 *
 *  [1]: https://docs.gradle.org/current/userguide/declaring_repositories.html#zip_uri
 */
import { extOf } from "./api"

export const RAW_PREFIX = "raw/"
export const TEXTY = new Set(["txt", "csv", "tsv", "json", "md", "log"])

export type Parsed =
    | { kind: "dir"; prefix: string }
    | { kind: "zip"; path: string }
    | { kind: "zipEntry"; path: string; entry: string }
    | { kind: "text"; path: string }
    | { kind: "parquet"; path: string }
    | { kind: "pdf"; path: string }
    | { kind: "binary"; path: string }

export function parsePath(splat: string): Parsed {
    let decoded: string
    try {
        decoded = decodeURIComponent(splat)
    } catch {
        decoded = splat  // malformed escape — fall back rather than throw
    }
    const stripped = decoded.replace(/^\/+/, "")  // drop leading slash
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
    if (ext === "pdf") return { kind: "pdf", path: r2key }
    if (TEXTY.has(ext)) return { kind: "text", path: r2key }

    // No extension and no trailing slash: assume directory (DOT users
    // often type `/raw/njdot/data/2023` without the slash).
    if (!ext) return { kind: "dir", prefix: r2key + "/" }

    return { kind: "binary", path: r2key }
}
