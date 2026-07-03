import { titleCase } from "@rdub/base/str"

export type MC2MN = { [mc: number]: string }
export type County = { cn: string, mc2mn: MC2MN }
export type CC2MC2MN = { [cc: number]: County }

export const normalize = (s: string) => s.toLowerCase().replaceAll(' ', '-')

export const denormalize = (s: string) => titleCase(s.replaceAll('-', ' '))

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
