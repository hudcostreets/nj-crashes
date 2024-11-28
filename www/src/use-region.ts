import { CC2MC2MN, County, denormalize, MC2MN, normalize } from "@/src/county";
import { useCallback, useEffect, useMemo, useState } from "react";
import { keys, mapEntries } from "@rdub/base/objs";
import { Arr } from "@rdub/base/arr";
import { useRouter } from "next/router";
import { CCMC } from "@/src/njsp/region";

export type Region = CCMC & {
    cn: string | null
    mn: string | null
    county?: County
    mc2mn?: MC2MN
    setCounty: (county: string | null) => void
    setCity?: (city: string) => void
    cities?: string[]
    cc2mc2mn: CC2MC2MN
}

export default function useRegion({ cc2mc2mn, urlPrefix, ...props }: CCMC & {
    cc2mc2mn: CC2MC2MN
    urlPrefix?: string
}): Region {
    const router = useRouter()
    const cn2cc: Record<string, number> = useMemo(() => mapEntries(cc2mc2mn, (cc, { cn }) => [ cn, cc ]), [ cc2mc2mn ])
    const [ cc, setCc ] = useState<number | null>(props.cc)
    const [ mc, setMc ] = useState<number | null>(props.mc)
    // console.log("useRegion", cc, mc)

    const updateCodes = useCallback(
        (url: string) => {
            if (!urlPrefix) return true
            if (!url.startsWith(urlPrefix + "/")) return true
            url = url.slice(urlPrefix.length + 1)
            const [ cn, mn ] = url.split("/").map(s => s ? denormalize(s) : undefined)
            console.log(`useRegion: updateCodes url ${url} cn ${cn} mn ${mn}`)
            if (!cn) {
                const cc = null
                console.log(`beforePopState setting cc ${cc}`)
                setCc(cc)
                return true
            } else {
                const cc = cn2cc[cn]
                console.log(`beforePopState setting cc ${cc}`)
                setCc(cc)
                if (!mn) {
                    const mc = null
                    console.log(`beforePopState setting mc ${mc}`)
                    setMc(mc)
                    return true
                } else {
                    const { mc2mn } = cc2mc2mn[cc]
                    const mn2mc = mapEntries(mc2mn, (mc, mn) => [ mn, mc ])
                    const mc = mn2mc[mn]
                    console.log(`beforePopState setting mc ${mc}`)
                    setMc(mc)
                    return true
                }
            }
        },
        [ urlPrefix, setCc, setMc, cn2cc, cc2mc2mn, ]
    )

    useEffect(() => {
        if (!urlPrefix) return
        router.beforePopState(({ as }) => {
            return updateCodes(as)
        })
        const handleRouteChange = (url: string) => {
            updateCodes(url)
        }

        router.events.on('routeChangeStart', handleRouteChange)

        // If the component is unmounted, unsubscribe
        // from the event with the `off` method:
        return () => {
            router.events.off('routeChangeStart', handleRouteChange)
        }
    }, [ router, urlPrefix, updateCodes, ])

    const setCounty = useCallback(
        (county: string | null) => {
            const cc = county ? cn2cc[county] : null
            console.log('new cc', cc)
            setCc(cc)
            if (urlPrefix !== undefined) {
                const url = `${urlPrefix}/${county ? normalize(county) : ""}`
                console.log(`pushing ${url}`)
                router.push(url, undefined, { shallow: true })
            }
        },
        [ cn2cc, setCc, urlPrefix, ]
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
                console.log(`pushing ${url}`)
                router.push(url, undefined, { shallow: true })
            }
        },
        [ setMc, urlPrefix, cn, mn2mc, ]
    )
    // console.log(`region returning cc ${cc} cn ${cn} mc ${mc} mn ${mn}`)
    return {
        cn: cn ?? null,
        mn: mn ?? null,
        county,
        cc, mc,
        mc2mn,
        setCounty,
        setCity: cc ? setCity : undefined,
        cities,
        cc2mc2mn,
    }
}
