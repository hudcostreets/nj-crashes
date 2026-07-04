/** Route handler for bare `/{muni-slug}` URLs — e.g. `/hopewell-boro`.
 *
 *  Resolves the slug against every county's muni list via `muniKey`
 *  (so `hopewell-boro`, `hopewell-borough`, `Hopewell Boro`, etc. all
 *  fold to the same canonical form). Three outcomes:
 *
 *    - Exactly one exact match → `<Navigate>` to `/c/{county}/{muni}`.
 *      Canonical URL bar reads `/c/...` after redirect (short-URL
 *      canonicalization to `/{muni}` is a follow-up that needs a
 *      GeoFilterProvider override path).
 *    - >1 exact matches → disambiguation picker listing each county.
 *    - 0 exact matches → not-found panel with Levenshtein "did you mean"
 *      suggestions across all counties.
 *
 *  Port Authority (`cc=99`) is excluded from both resolution and
 *  suggestion (per `suggestMunisStatewide`). */
import { useEffect, useState } from "react"
import { Link, Navigate, useParams } from "react-router-dom"
import { CC2MC2MN, muniKey, normalize, suggestMunisStatewide } from "@/src/county"
import { loadCC2MC2MN } from "@/src/lib/data"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import css from "@/src/components/RegionNotFound.module.scss"

type ExactMatch = { cc: number, cn: string, countySlug: string, mc: number, mn: string, muniSlug: string }

function exactMatches(slug: string, cc2mc2mn: CC2MC2MN): ExactMatch[] {
    const key = muniKey(slug.replace(/-/g, " "))
    const out: ExactMatch[] = []
    for (const [cc, county] of Object.entries(cc2mc2mn)) {
        if (Number(cc) === 99) continue
        const countySlug = normalize(county.cn)
        for (const [mc, mn] of Object.entries(county.mc2mn)) {
            if (muniKey(mn) === key) {
                out.push({ cc: Number(cc), cn: county.cn, countySlug, mc: Number(mc), mn, muniSlug: normalize(mn) })
            }
        }
    }
    return out
}

export default function MuniSlugRoute() {
    const { muniSlug } = useParams<{ muniSlug: string }>()
    const [cc2mc2mn, setCc2mc2mn] = useState<CC2MC2MN | null>(null)
    useEffect(() => { loadCC2MC2MN().then(setCc2mc2mn).catch(() => {}) }, [])

    if (!muniSlug) return null
    if (!cc2mc2mn) return <div style={{ padding: "1em" }}>Loading…</div>

    const matches = exactMatches(muniSlug, cc2mc2mn)

    if (matches.length === 1) {
        const m = matches[0]
        return <Navigate replace to={`/c/${m.countySlug}/${m.muniSlug}`} />
    }

    if (matches.length > 1) {
        return (
            <div className={css.notFound} role="dialog" aria-label="Choose a municipality">
                <Head title={`${matches[0].mn} — pick a county`} description="Multiple municipalities match this name" url={url} />
                <h1>Multiple matches</h1>
                <p>
                    <code>{muniSlug}</code> matches {matches.length} municipalities:
                </p>
                <ul className={css.suggestions}>
                    {matches.map(m => (
                        <li key={`${m.cc}-${m.mc}`}>
                            <Link to={`/c/${m.countySlug}/${m.muniSlug}`}>{m.mn}, {m.cn} County</Link>
                        </li>
                    ))}
                </ul>
                <p className={css.up}>Or view the <Link to="/">whole state</Link>.</p>
            </div>
        )
    }

    // 0 exact matches — offer fuzzy state-wide suggestions.
    const suggestions = suggestMunisStatewide(muniSlug, cc2mc2mn)
    return (
        <div className={css.notFound} role="alert">
            <Head title="Not found — NJ Car Crash Data" description="Unknown municipality" url={url} />
            <h1>Not found</h1>
            <p><code>{muniSlug}</code> isn't a municipality in NJ.</p>
            {suggestions.length > 0 && (
                <>
                    <p>Did you mean:</p>
                    <ul className={css.suggestions}>
                        {suggestions.map(s => (
                            <li key={`${s.cc}-${s.mc}`}>
                                <Link to={`/c/${s.countySlug}/${s.slug}`}>{s.mn}, {s.cn} County</Link>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <p className={css.up}>Or view the <Link to="/">whole state</Link>.</p>
        </div>
    )
}
