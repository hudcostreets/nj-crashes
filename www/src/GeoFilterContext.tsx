import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { CC2MC2MN, denormalize, normalize } from "@/src/county"
import { loadCC2MC2MN } from "@/src/lib/data"
import { mapEntries } from "@rdub/base/objs"

export type GeoFilter = {
    cc: number | null
    mc: number | null
    countyName: string | null
    municipalityName: string | null
    cc2mc2mn: CC2MC2MN | null
    setCounty: (name: string | null) => void
    setMunicipality: (name: string | null) => void
    /** URL slugs from the current route that didn't resolve to codes.
     *  `countySlugUnresolved` is set when `/c/<slug>/...` has no matching
     *  county name; `muniSlugUnresolved` is set when the county resolved
     *  but the muni segment didn't. Consumers render a "not found" panel
     *  with suggestions instead of silently falling through. Both are
     *  `null` on the happy path (or when `cc2mc2mn` is still loading). */
    countySlugUnresolved: string | null
    muniSlugUnresolved: string | null
}

const GeoFilterContext = createContext<GeoFilter>({
    cc: null,
    mc: null,
    countyName: null,
    municipalityName: null,
    cc2mc2mn: null,
    setCounty: () => {},
    setMunicipality: () => {},
    countySlugUnresolved: null,
    muniSlugUnresolved: null,
})

export function useGeoFilter() {
    return useContext(GeoFilterContext)
}

/** Explicit scope override for callers that resolve `(cc, mc)` from a
 *  non-`/c/:county/:city` route (e.g. `/{muni-slug}`) and want to render
 *  the muni page inline. When provided, bypasses `useParams` resolution;
 *  the values here go straight into the context. */
export type GeoScopeOverride = { cc: number, mc: number | null, countyName: string, municipalityName: string | null }

export function GeoFilterProvider({ children, override }: { children: React.ReactNode, override?: GeoScopeOverride }) {
    const { county: countySlug, city: citySlug } = useParams<{ county?: string; city?: string }>()
    const navigate = useNavigate()
    const [cc2mc2mn, setCc2mc2mn] = useState<CC2MC2MN | null>(null)

    useEffect(() => {
        loadCC2MC2MN().then(setCc2mc2mn)
    }, [])

    // Reverse lookup: county name → code
    const cn2cc = useMemo(
        () => cc2mc2mn ? mapEntries(cc2mc2mn, (cc, { cn }) => [cn, cc]) : {},
        [cc2mc2mn],
    )

    // Resolve route params to codes and names. On failure, surface the
    // raw slug via `countySlugUnresolved` / `muniSlugUnresolved` so callers
    // can render a "not found" panel instead of silently falling through
    // to the state / county view. If `override` is supplied, skip param
    // parsing entirely and use those values.
    const { cc, mc, countyName, municipalityName, countySlugUnresolved, muniSlugUnresolved } = useMemo(() => {
        const empty = {
            cc: null, mc: null, countyName: null, municipalityName: null,
            countySlugUnresolved: null, muniSlugUnresolved: null,
        }
        if (override) {
            return {
                ...empty,
                cc: override.cc,
                mc: override.mc,
                countyName: override.countyName,
                municipalityName: override.municipalityName,
            }
        }
        if (!cc2mc2mn || !countySlug) return empty
        const cn = denormalize(countySlug)
        const ccRaw = cn2cc[cn] ?? null
        const cc = ccRaw !== null ? Number(ccRaw) : null
        if (cc === null) return { ...empty, countySlugUnresolved: countySlug }
        if (!citySlug) return { ...empty, cc, countyName: cn }
        const mn = denormalize(citySlug)
        const { mc2mn } = cc2mc2mn[cc]
        const mn2mc = mapEntries(mc2mn, (mc, name) => [name, mc])
        const mcRaw = mn2mc[mn] ?? null
        const mc = mcRaw !== null ? Number(mcRaw) : null
        if (mc === null) return { ...empty, cc, countyName: cn, muniSlugUnresolved: citySlug }
        return { ...empty, cc, mc, countyName: cn, municipalityName: mn }
    }, [cc2mc2mn, countySlug, citySlug, cn2cc, override])

    const setCounty = (name: string | null) => {
        if (name) {
            navigate(`/c/${normalize(name)}`)
        } else {
            navigate('/')
        }
    }

    const setMunicipality = (name: string | null) => {
        if (name && countyName) {
            navigate(`/c/${normalize(countyName)}/${normalize(name)}`)
        } else if (countyName) {
            navigate(`/c/${normalize(countyName)}`)
        }
    }

    const value = useMemo<GeoFilter>(() => ({
        cc, mc, countyName, municipalityName, cc2mc2mn, setCounty, setMunicipality,
        countySlugUnresolved, muniSlugUnresolved,
    }), [cc, mc, countyName, municipalityName, cc2mc2mn, countySlugUnresolved, muniSlugUnresolved])

    return (
        <GeoFilterContext.Provider value={value}>
            {children}
        </GeoFilterContext.Provider>
    )
}
