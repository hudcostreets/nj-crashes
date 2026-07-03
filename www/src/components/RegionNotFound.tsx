import { Link } from "react-router-dom"
import { CC2MC2MN, MC2MN, MuniSuggestion, normalize, suggestMunis } from "@/src/county"
import css from "./RegionNotFound.module.scss"

type CountySuggestion = { cc: number, cn: string, slug: string, similarity: number }

/** Rank counties by slug similarity to `slug`; used when a URL's county
 *  segment doesn't resolve (typo, dropped word, wrong state). Mirrors
 *  `suggestMunis` but with the flat cc→cn map. */
function suggestCounties(
    slug: string,
    cc2mc2mn: CC2MC2MN,
    { limit = 3, threshold = 0.4 }: { limit?: number, threshold?: number } = {},
): CountySuggestion[] {
    const target = slug.toLowerCase()
    const scored: CountySuggestion[] = Object.entries(cc2mc2mn).map(([cc, county]) => {
        const candSlug = normalize(county.cn)
        // Inline Levenshtein call would create a cycle; just proxy through
        // `suggestMunis` semantics — but we want county names, so replicate
        // the calc here (small O(n·m)).
        const a = target, b = candSlug
        const m = a.length, n = b.length
        let prev = Array.from({ length: n + 1 }, (_, i) => i)
        const curr = new Array<number>(n + 1)
        for (let i = 1; i <= m; i++) {
            curr[0] = i
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1
                curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            }
            prev = [...curr]
        }
        const dist = prev[n]
        const maxLen = Math.max(m, n)
        const similarity = maxLen === 0 ? 1 : 1 - dist / maxLen
        return { cc: Number(cc), cn: county.cn, slug: candSlug, similarity }
    })
    return scored
        .filter(s => s.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
}

type Props = {
    /** Which level of the URL failed. */
    kind: 'county' | 'muni'
    /** The raw URL slug that didn't resolve. */
    slug: string
    /** For `kind: 'muni'`, the county name that DID resolve — used in the
     *  "not found in Foo County" copy. */
    countyName?: string | null
    /** For `kind: 'muni'`, the county slug that DID resolve — used to
     *  build suggestion URLs. */
    countySlug?: string
    /** For `kind: 'muni'`, the county's `mc2mn` table for finding near
     *  matches. */
    mc2mn?: MC2MN
    /** For `kind: 'county'`, the full `cc2mc2mn` for finding near
     *  matches. */
    cc2mc2mn?: CC2MC2MN | null
}

export function RegionNotFound({ kind, slug, countyName, countySlug, mc2mn, cc2mc2mn }: Props) {
    const muniSuggestions: MuniSuggestion[] = kind === 'muni' && mc2mn
        ? suggestMunis(slug, mc2mn)
        : []
    const countySuggestions: CountySuggestion[] = kind === 'county' && cc2mc2mn
        ? suggestCounties(slug, cc2mc2mn)
        : []
    const scope = kind === 'muni' && countyName ? `${countyName} County` : 'NJ'
    return (
        <div className={css.notFound} role="alert">
            <h1>Not found</h1>
            <p>
                <code>{slug}</code> isn't a {kind === 'muni' ? 'municipality' : 'county'} in {scope}.
            </p>
            {muniSuggestions.length > 0 && countySlug && (
                <>
                    <p>Did you mean:</p>
                    <ul className={css.suggestions}>
                        {muniSuggestions.map(s => (
                            <li key={s.mc}>
                                <Link to={`/c/${countySlug}/${s.slug}`}>{s.mn}</Link>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            {countySuggestions.length > 0 && (
                <>
                    <p>Did you mean:</p>
                    <ul className={css.suggestions}>
                        {countySuggestions.map(s => (
                            <li key={s.cc}>
                                <Link to={`/c/${s.slug}`}>{s.cn} County</Link>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <p className={css.up}>
                {kind === 'muni' && countyName && countySlug ? (
                    <>
                        Or view <Link to={`/c/${countySlug}`}>all of {countyName} County</Link>{' '}
                        or the <Link to="/">whole state</Link>.
                    </>
                ) : (
                    <>Or view the <Link to="/">whole state</Link>.</>
                )}
            </p>
        </div>
    )
}
