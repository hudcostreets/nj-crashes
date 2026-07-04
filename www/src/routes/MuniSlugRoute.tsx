/** Route handler for bare `/{muni-slug}` URLs — e.g. `/hopewell-boro`,
 *  `/washington-twp-bergen`.
 *
 *  Resolves the slug against every county's muni list. When exactly one
 *  muni matches, renders the muni page INLINE (URL bar stays on the
 *  short form — the short slug is the canonical URL). Multiple matches
 *  render a disambig picker; zero matches render a not-found panel with
 *  fuzzy suggestions.
 *
 *  Match rule (`slugMatchesMuni`):
 *  - Stems must be equal.
 *  - If input has a type (`boro`/`twp`/`city`/`village`), candidate must
 *    match it exactly.
 *  - If input has a county suffix (`-bergen`, `-cape-may`), candidate's
 *    county must match.
 *
 *  Port Authority (`cc=99`) excluded throughout. */
import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { CC2MC2MN, normalize, parseSlugFull, slugMatchesMuni, suggestMunisStatewide } from "@/src/county"
import { loadCC2MC2MN } from "@/src/lib/data"
import { Head } from "@/src/lib/head"
import { url } from "@/src/site"
import GeoHome from "./GeoHome"
import css from "@/src/components/RegionNotFound.module.scss"

type ExactMatch = { cc: number, cn: string, countySlug: string, mc: number, mn: string, muniSlug: string }

/** Resolve a slug against `cc2mc2mn` via `parseSlugFull` + `slugMatchesMuni`.
 *  Also honors an optional trailing county-name in the slug (e.g.
 *  `washington-twp-bergen`). Filters out `cc=99` (Port Authority). */
function resolveMatches(slug: string, cc2mc2mn: CC2MC2MN, countyNames: Set<string>): ExactMatch[] {
    const input = parseSlugFull(slug, countyNames)
    const out: ExactMatch[] = []
    for (const [cc, county] of Object.entries(cc2mc2mn)) {
        if (Number(cc) === 99) continue
        if (input.county && input.county !== county.cn.toLowerCase()) continue
        const countySlug = normalize(county.cn)
        for (const [mc, mn] of Object.entries(county.mc2mn)) {
            const candidate = parseSlugFull(mn, countyNames)
            if (slugMatchesMuni(input, candidate)) {
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

    const countyNames = useMemo(
        () => cc2mc2mn ? new Set(Object.values(cc2mc2mn).map(c => c.cn.toLowerCase())) : new Set<string>(),
        [cc2mc2mn],
    )

    if (!muniSlug) return null
    if (!cc2mc2mn) return <div style={{ padding: "1em" }}>Loading…</div>

    const matches = resolveMatches(muniSlug, cc2mc2mn, countyNames)

    // Unique match → render the muni page INLINE. The short slug stays in
    // the URL bar (it's the canonical URL for this muni).
    if (matches.length === 1) {
        const m = matches[0]
        return <GeoHome override={{ cc: m.cc, mc: m.mc, countyName: m.cn, municipalityName: m.mn }} />
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
