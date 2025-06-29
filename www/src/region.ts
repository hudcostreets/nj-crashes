import { CC2MC2MN, County, MC2MN } from "@/src/county"
import { CCMC } from "@/src/njsp/region"

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
