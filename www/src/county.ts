import { titleCase } from "@rdub/base/str"

export type MC2MN = { [mc: number]: string }
export type County = { cn: string, mc2mn: MC2MN }
export type CC2MC2MN = { [cc: number]: County }

export const normalize = (s: string) => s.toLowerCase().replaceAll(' ', '-')

export const denormalize = (s: string) => titleCase(s.replaceAll('-', ' '))

/** Canonical key for matching a municipality name across data sources.
 *
 *  NJDOT abbreviates municipality suffixes ("Hopewell Boro", "Hopewell
 *  Twp") while the map/GIS data (`muni-maps.json`, muni GeoJSON) spells
 *  them out ("Hopewell Borough", "Hopewell Township"). The two disagree
 *  for the same town, so the exact-string reverse lookups that turn a URL
 *  slug back into an `mc` silently fail — e.g. picking "Hopewell Borough"
 *  never resolves its code and the map won't focus. Pennington only works
 *  because it happens to be spelled identically in both sources.
 *
 *  Fold both spellings to one key by *expanding* the abbreviations
 *  (Boro→Borough, Twp→Township), never stripping the suffix — stripping
 *  would collapse "Hopewell Borough" and "Hopewell Township" onto the same
 *  key and collide two distinct municipalities. Lowercased and
 *  whitespace-collapsed so it's safe to key on either the abbreviated or
 *  the full form. */
export const muniKey = (s: string): string =>
    s.toLowerCase()
        .replace(/\btwp\.?(?=\s|$)/g, 'township')
        .replace(/\bboro\.?(?=\s|$)/g, 'borough')
        .replace(/\s+/g, ' ')
        .trim()

/** Canonicalize a muni type suffix. `Boro`/`Borough` → `boro`,
 *  `Twp`/`Township` → `twp`, `City` → `city`, `Village` → `village`.
 *  Returns undefined for anything else. */
export function canonicalType(word: string): string | undefined {
    const w = word.toLowerCase().replace(/\.$/, '')
    if (w === 'boro' || w === 'borough') return 'boro'
    if (w === 'twp' || w === 'township') return 'twp'
    if (w === 'city') return 'city'
    if (w === 'village') return 'village'
    return undefined
}

/** Split a slug or muni name into `{ stem, type? }`. `hopewell-boro` →
 *  `{ stem: 'hopewell', type: 'boro' }`; `hopewell` → `{ stem: 'hopewell' }`.
 *  Whitespace and hyphens both split words; case-insensitive; strips the
 *  trailing period `.` on `Twp.`/`Boro.` NJDOT variants.
 *
 *  NOTE: only strips a *single* trailing type token. `Long Beach Twp` →
 *  `{ stem: 'long beach', type: 'twp' }`. `New Providence` → no trailing
 *  type → `{ stem: 'new providence' }`. */
export function parseSlug(s: string): { stem: string, type?: string } {
    const words = s.toLowerCase().replace(/[-_.]+/g, ' ').split(/\s+/).filter(Boolean)
    if (words.length < 2) return { stem: words.join(' ') }
    const last = words[words.length - 1]
    const type = canonicalType(last)
    if (type) return { stem: words.slice(0, -1).join(' '), type }
    return { stem: words.join(' ') }
}

/** Match rule between an input slug and a candidate muni. Strict when the
 *  input specifies a type; wildcard when it doesn't.
 *
 *  - Stems must be equal.
 *  - If input has no type: any candidate with the same stem matches.
 *  - If input has a type: candidate must have the same type. Candidates
 *    with no stored type (e.g. Cumberland's "Hopewell") are *excluded* —
 *    this is a known limitation until `cc2mc2mn.json` stores types. */
export function slugMatchesMuni(input: { stem: string, type?: string }, candidate: { stem: string, type?: string }): boolean {
    if (input.stem !== candidate.stem) return false
    if (input.type === undefined) return true
    return candidate.type === input.type
}

/** Extended parseSlug that also detects a trailing county-name disambiguator
 *  (e.g. `washington-twp-bergen` → `{stem: 'washington', type: 'twp',
 *  county: 'bergen'}`; `washington-twp-cape-may` → county `'cape may'`).
 *
 *  `countyNames` is the lowercase set of NJ county names — pass
 *  `new Set(Object.values(cc2mc2mn).map(c => c.cn.toLowerCase()))`. Both
 *  single-word (Bergen, Morris) and multi-word (Cape May) are supported;
 *  the parser prefers the longest matching trailing county name so
 *  `cape-may` doesn't get truncated to just `may`. */
export function parseSlugFull(
    s: string,
    countyNames: Set<string>,
): { stem: string, type?: string, county?: string } {
    const words = s.toLowerCase().replace(/[-_.]+/g, ' ').split(/\s+/).filter(Boolean)
    let county: string | undefined
    // Try longest trailing county match first (2-word "cape may" > 1-word "may").
    for (const n of [2, 1]) {
        if (words.length > n) {
            const tail = words.slice(-n).join(' ')
            if (countyNames.has(tail)) {
                county = tail
                words.splice(-n, n)
                break
            }
        }
    }
    let type: string | undefined
    if (words.length >= 2) {
        const canonType = canonicalType(words[words.length - 1])
        if (canonType) {
            type = canonType
            words.pop()
        }
    }
    return { stem: words.join(' '), ...(type && { type }), ...(county && { county }) }
}

/** Compute the shortest slug that uniquely resolves to `(cc, mc)` under
 *  `slugMatchesMuni`. If `(stem, type)` is unique state-wide (excluding
 *  `cc=99` Port Authority), returns `{stem}-{type}` (or `{stem}` when the
 *  muni has no type suffix). Otherwise appends the county slug to
 *  disambiguate. Returns null if the muni isn't in `cc2mc2mn`. */
export function canonicalMuniSlug(cc: number, mc: number, cc2mc2mn: CC2MC2MN): string | null {
    const county = cc2mc2mn[cc]
    if (!county) return null
    const mn = county.mc2mn[mc]
    if (!mn) return null
    const parsed = parseSlug(mn)
    let count = 0
    for (const [cc2, county2] of Object.entries(cc2mc2mn)) {
        if (Number(cc2) === 99) continue
        for (const mn2 of Object.values(county2.mc2mn)) {
            const p2 = parseSlug(mn2)
            if (slugMatchesMuni(parsed, p2)) count++
        }
    }
    const short = parsed.type ? `${parsed.stem}-${parsed.type}` : parsed.stem
    const shortSlug = short.replace(/\s+/g, '-')
    if (count === 1) return shortSlug
    return `${shortSlug}-${normalize(county.cn)}`
}

/** Levenshtein edit distance. Small helper — NJ counties have ~20-40 munis
 *  and slugs stay short, so an O(mn) DP is fine. */
export function levenshtein(a: string, b: string): number {
    if (a === b) return 0
    if (!a.length) return b.length
    if (!b.length) return a.length
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    const curr = new Array<number>(b.length + 1)
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        }
        prev = [...curr]
    }
    return prev[b.length]
}

export type MuniSuggestion = { mc: number, mn: string, slug: string, similarity: number }

/** State-wide muni suggestion: also carries the containing county so a
 *  URL like `/hopewell-boro` (no county segment) can be resolved to
 *  `/c/{countySlug}/{muniSlug}`. */
export type StatewideMuniSuggestion = MuniSuggestion & { cc: number, cn: string, countySlug: string }

/** Search all counties' munis for slug matches. Uses the same
 *  Levenshtein-similarity ranking as `suggestMunis`, but flattens across
 *  the whole state. Also filters out `cc=99` (Port Authority — not a
 *  real jurisdiction users would type as a slug). */
export function suggestMunisStatewide(
    slug: string,
    cc2mc2mn: CC2MC2MN,
    { limit = 5, threshold = 0.5 }: { limit?: number, threshold?: number } = {},
): StatewideMuniSuggestion[] {
    const target = slug.toLowerCase()
    const scored: StatewideMuniSuggestion[] = []
    for (const [cc, county] of Object.entries(cc2mc2mn)) {
        if (Number(cc) === 99) continue
        const countySlug = normalize(county.cn)
        for (const [mc, mn] of Object.entries(county.mc2mn)) {
            const candSlug = normalize(mn)
            const dist = levenshtein(target, candSlug)
            const maxLen = Math.max(target.length, candSlug.length)
            const similarity = maxLen === 0 ? 1 : 1 - dist / maxLen
            if (similarity < threshold) continue
            scored.push({ mc: Number(mc), mn, slug: candSlug, similarity, cc: Number(cc), cn: county.cn, countySlug })
        }
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
}

/** Rank a county's munis by slug similarity to `slug`, returning up to
 *  `limit` matches above the `threshold` similarity (0..1 normalized
 *  Levenshtein). Used to answer "did you mean" when a URL slug doesn't
 *  resolve to a muni code. */
export function suggestMunis(
    slug: string,
    mc2mn: Record<string | number, string>,
    { limit = 3, threshold = 0.4 }: { limit?: number, threshold?: number } = {},
): MuniSuggestion[] {
    const target = slug.toLowerCase()
    const scored: MuniSuggestion[] = Object.entries(mc2mn).map(([mc, mn]) => {
        const candSlug = normalize(mn)
        const dist = levenshtein(target, candSlug)
        const maxLen = Math.max(target.length, candSlug.length)
        const similarity = maxLen === 0 ? 1 : 1 - dist / maxLen
        return { mc: Number(mc), mn, slug: candSlug, similarity }
    })
    return scored
        .filter(s => s.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
}
