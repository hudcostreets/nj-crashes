import { CC2MC2MN, County, denormalize, MC2MN, normalize } from "@/src/county";
import { useCallback, useMemo } from "react";
import { keys, mapEntries } from "@rdub/base/objs";
import { Arr } from "@rdub/base/arr";
import { State } from "@rdub/base/state";

export type Region = {
  cn: string | null
  mn: string | null
  county?: County
  cc: number | null
  mc: number | null
  mc2mn?: MC2MN
  setCounty: (county: string | null) => void
  setCity?: (city: string) => void
  cities?: string[]
  cc2mc2mn: CC2MC2MN
}

export default function useRegion(
  { cs, setCs, ms, setMs, cc2mc2mn, urlPrefix }: State<string | undefined, 'cs'> & State<string | undefined, 'ms'> & {
    cc2mc2mn: CC2MC2MN
    urlPrefix?: string
  }): Region {
  const cn2cc: Record<string, number> = useMemo(() => mapEntries(cc2mc2mn, (cc, { cn }) => [ cn, cc ]), [ cc2mc2mn ])
  const { cc, mc } = useMemo(() => {
      let cc: number | null = null
      let mc: number | null = null
      if (cs !== undefined) {
        const csn = denormalize(cs)
        if (csn in cn2cc) {
          cc = cn2cc[csn]
          if (ms !== undefined) {
            const { mc2mn } = cc2mc2mn[cc]
            const ms2mc = mapEntries(mc2mn, (mc, mn) => [ normalize(mn), mc ])
            if (ms in ms2mc) {
              mc = ms2mc[ms]
            } else {
              console.warn(`useRegion: unknown county ${cs} muni ${ms}; options:`, ms2mc)
            }
          }
        } else {
          console.warn(`useRegion: unknown county ${cs}`)
        }
      }
      return { cc, mc }
    }, [ cs, ms ]
  )

  const setCounty = useCallback(
    (county: string | null) => {
      const cc = county ? cn2cc[county] : null
      console.log('new cc', cc)
      if (cc === null) {
        setCs(undefined)
        setMs(undefined)
      } else {
        const cs = normalize(cc2mc2mn[cc].cn)
        console.log("param setCs:", cs)
        setCs(cs)
      }
    },
    [ cn2cc, setCs, urlPrefix, ]
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
  const setCity = useCallback(
    (city: string) => {
      if (!mn2mc) {
        console.warn(`Attempting to select city ${city} with no mn2mc (cc ${cc})`)
        return
      }
      const mc = mn2mc[city]
      if (cc === null || mc === null) {
        setMs(undefined)
      } else {
        const ms = normalize(cc2mc2mn[cc].mc2mn[mc])
        console.log("param setMs:", ms)
        setMs(ms)
      }
    },
    [ setMs, urlPrefix,cc, mn2mc, ]
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
