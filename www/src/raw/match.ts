/** Filename matcher used by `<DirListing>`'s filter input.
 *
 *  Bare text → case-insensitive substring (`pedestr` matches all
 *  `…Pedestrians…`).
 *
 *  Presence of `*` or `?` → anchored glob (`NewJersey*` matches
 *  `NewJersey2022Drivers.zip` but NOT `Atlantic2023…`). Other regex
 *  metacharacters are escaped so `(2023)` etc. don't blow up.
 */

export function globToRegex(pattern: string): RegExp {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    const wild = esc.replace(/\*/g, ".*").replace(/\?/g, ".")
    return new RegExp(`^${wild}$`, "i")
}

export function makeMatcher(q: string): (s: string) => boolean {
    if (!q) return () => true
    if (/[*?]/.test(q)) {
        const re = globToRegex(q)
        return (s) => re.test(s)
    }
    const lc = q.toLowerCase()
    return (s) => s.toLowerCase().includes(lc)
}
