import { CC2MC2MN, County, denormalize, MC2MN, normalize } from "@/src/county";
import { useCallback, useEffect, useMemo, useState } from "react";
import { keys, mapEntries } from "@rdub/base/objs";
import { Arr } from "@rdub/base/arr";
import { useNavigate, useLocation } from "react-router-dom";

export type Region = {
    cn?: string
    mn?: string
    county?: County
    cc: number | null
    mc: number | null
    mc2mn?: MC2MN
    setCounty: (county: string | null) => void
    setCity?: (city: string) => void
    cities?: string[]
    cc2mc2mn: CC2MC2MN
}

export default function useRegion({ cc2mc2mn, urlPrefix, ...props }: {
    cc: number | null
    mc: number | null
    cc2mc2mn: CC2MC2MN
    urlPrefix?: string
}): Region {
    const navigate = useNavigate()
    const location = useLocation()
    const cn2cc: Record<string, number> = useMemo(() => mapEntries(cc2mc2mn, (cc, { cn }) => [ cn, cc ]), [ cc2mc2mn ])
    const [ cc, setCc ] = useState<number | null>(props.cc)
    const [ mc, setMc ] = useState<number | null>(props.mc)

    const updateCodes = useCallback(
        (pathname: string) => {
            if (!urlPrefix) return
            if (!pathname.startsWith(urlPrefix + "/") && pathname !== urlPrefix) return
            const suffix = pathname === urlPrefix ? "" : pathname.slice(urlPrefix.length + 1)
            const [ cnPart, mnPart ] = suffix.split("/").map(s => s ? denormalize(s) : undefined)
            console.log(`useRegion: updateCodes pathname ${pathname} cn ${cnPart} mn ${mnPart}`)
            if (!cnPart) {
                console.log(`setting cc null`)
                setCc(null)
            } else {
                const newCc = cn2cc[cnPart]
                console.log(`setting cc ${newCc}`)
                setCc(newCc)
                if (!mnPart) {
                    console.log(`setting mc null`)
                    setMc(null)
                } else {
                    const { mc2mn } = cc2mc2mn[newCc]
                    const mn2mc = mapEntries(mc2mn, (mc, mn) => [ mn, mc ])
                    const newMc = mn2mc[mnPart]
                    console.log(`setting mc ${newMc}`)
                    setMc(newMc)
                }
            }
        },
        [ urlPrefix, setCc, setMc, cn2cc, cc2mc2mn, ]
    )

    // Update state when location changes (handles browser back/forward)
    useEffect(() => {
        if (!urlPrefix) return
        updateCodes(location.pathname)
    }, [ location.pathname, urlPrefix, updateCodes, ])

    const setCounty = useCallback(
        (county: string | null) => {
            const cc = county ? cn2cc[county] : null
            console.log('new cc', cc)
            setCc(cc)
            if (urlPrefix !== undefined) {
                const url = `${urlPrefix}/${county ? normalize(county) : ""}`
                console.log(`navigating to ${url}`)
                navigate(url)
            }
        },
        [ cn2cc, setCc, urlPrefix, navigate, ]
    )
    const { county, cn, mn, mc2mn, mn2mc, cities, }: {
        county?: County
        cn?: string
        mn?: string
        mc2mn?: MC2MN
        mn2mc?: Record<string, number>
        cities?: string[]
    } = useMemo(
        () => {
            if (!cc) return {}
            const county = cc2mc2mn[cc]
            const { cn, mc2mn } = county
            const mn2mc = mapEntries(mc2mn, (mc, mn) => [ mn, mc ])
            const cities = Arr(keys(mn2mc))
            const mn = mc2mn && mc ? mc2mn[mc] : undefined
            return { county, cn, mn, mc2mn, mn2mc, cities, }
        },
        [ cc, cc2mc2mn, ]
    )
    // const mn = useMemo(() => mc2mn && mc ? mc2mn[mc] : undefined, [ mc, mc2mn ])
    const setCity = useCallback(
        (city: string) => {
            if (!mn2mc) {
                console.warn(`Attempting to select city ${city} with no mn2mc (cc ${cc})`)
                return
            }
            const mc = mn2mc[city]
            setMc(mc)
            if (urlPrefix !== undefined && cn) {
                const url = `${urlPrefix}/${normalize(cn)}/${normalize(city)}`
                console.log(`navigating to ${url}`)
                navigate(url)
            }
        },
        [ setMc, urlPrefix, cn, mn2mc, navigate, ]
    )
    // console.log(`region returning cc ${cc} cn ${cn} mc ${mc} mn ${mn}`)
    return {
        cn, mn,
        county,
        cc, mc,
        mc2mn,
        setCounty,
        setCity: cc ? setCity : undefined,
        cities,
        cc2mc2mn,
    }
}
