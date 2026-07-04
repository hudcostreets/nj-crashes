/** Wraps `GeoHome` for the `/c/:county[/:city]` routes and redirects to
 *  the canonical short slug when one exists.
 *
 *  - `/c/mercer/hopewell-boro` → `/hopewell-boro` (unique in NJ)
 *  - `/c/bergen/washington-twp` → `/washington-twp-bergen` (6 Washington
 *    Twps state-wide; county disambiguation appended)
 *  - `/c/mercer` (county-only, no muni) → no redirect (`/mercer` doesn't
 *    exist as a route yet; that's a separate follow-up)
 *
 *  Query strings and hashes are preserved verbatim through the redirect.
 *  If the URL doesn't resolve to a known `(cc, mc)` (unresolved slug,
 *  Port Authority, still loading manifest), renders `GeoHome` as-is so
 *  the standard not-found panels kick in. */
import { useEffect, useMemo, useState } from "react"
import { Navigate, useLocation, useParams } from "react-router-dom"
import { CC2MC2MN, canonicalMuniSlug, denormalize } from "@/src/county"
import { loadCC2MC2MN } from "@/src/lib/data"
import { mapEntries } from "@rdub/base/objs"
import GeoHome from "./GeoHome"

export default function CanonicalizeMuni() {
    const { county: countySlug, city: citySlug } = useParams<{ county?: string; city?: string }>()
    const { search, hash } = useLocation()
    const [cc2mc2mn, setCc2mc2mn] = useState<CC2MC2MN | null>(null)
    useEffect(() => { loadCC2MC2MN().then(setCc2mc2mn).catch(() => {}) }, [])

    const canonical = useMemo(() => {
        if (!cc2mc2mn || !countySlug || !citySlug) return null
        const cn2cc = mapEntries(cc2mc2mn, (cc, { cn }) => [cn, cc])
        const cn = denormalize(countySlug)
        const ccRaw = cn2cc[cn]
        if (ccRaw === undefined) return null
        const cc = Number(ccRaw)
        const { mc2mn } = cc2mc2mn[cc]
        // Match muni via muniKey-style: exact after case + suffix folding.
        // Reuse the same folding by iterating.
        const targetKey = citySlug.toLowerCase().replace(/-/g, ' ')
        for (const [mc, mn] of Object.entries(mc2mn)) {
            const stored = mn.toLowerCase()
                .replace(/\btwp\.?(?=\s|$)/g, 'township')
                .replace(/\bboro\.?(?=\s|$)/g, 'borough')
                .replace(/\s+/g, ' ')
                .trim()
            const input = targetKey
                .replace(/\btwp\.?(?=\s|$)/g, 'township')
                .replace(/\bboro\.?(?=\s|$)/g, 'borough')
                .replace(/\s+/g, ' ')
                .trim()
            if (stored === input) return canonicalMuniSlug(cc, Number(mc), cc2mc2mn)
        }
        return null
    }, [cc2mc2mn, countySlug, citySlug])

    if (canonical) return <Navigate replace to={`/${canonical}${search}${hash}`} />
    return <GeoHome />
}
