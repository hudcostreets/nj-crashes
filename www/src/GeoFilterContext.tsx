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
}

const GeoFilterContext = createContext<GeoFilter>({
    cc: null,
    mc: null,
    countyName: null,
    municipalityName: null,
    cc2mc2mn: null,
    setCounty: () => {},
    setMunicipality: () => {},
})

export function useGeoFilter() {
    return useContext(GeoFilterContext)
}

export function GeoFilterProvider({ children }: { children: React.ReactNode }) {
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

    // Resolve route params to codes and names
    const { cc, mc, countyName, municipalityName } = useMemo(() => {
        if (!cc2mc2mn || !countySlug) return { cc: null, mc: null, countyName: null, municipalityName: null }
        const cn = denormalize(countySlug)
        const ccRaw = cn2cc[cn] ?? null
        const cc = ccRaw !== null ? Number(ccRaw) : null
        if (cc === null) return { cc: null, mc: null, countyName: null, municipalityName: null }
        if (!citySlug) return { cc, mc: null, countyName: cn, municipalityName: null }
        const mn = denormalize(citySlug)
        const { mc2mn } = cc2mc2mn[cc]
        const mn2mc = mapEntries(mc2mn, (mc, name) => [name, mc])
        const mc = mn2mc[mn] ?? null
        return { cc, mc, countyName: cn, municipalityName: mc !== null ? mn : null }
    }, [cc2mc2mn, countySlug, citySlug, cn2cc])

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
    }), [cc, mc, countyName, municipalityName, cc2mc2mn])

    return (
        <GeoFilterContext.Provider value={value}>
            {children}
        </GeoFilterContext.Provider>
    )
}
