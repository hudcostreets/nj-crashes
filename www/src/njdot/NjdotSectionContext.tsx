import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { StartYear, EndYear } from "@/src/constants"

/** Year-range default for the NJDOT section filter bar — full span of the
 *  NJDOT raw + AASHTO-supplemented crash data (2001 → `EndYear`). */
export const NJDOT_YEAR_RANGE_DEFAULT: [number, number] = [StartYear, EndYear]

/** `ndy` URL param: NJDOT-section year range, `"<a>-<b>"`. Default returns
 *  `undefined` so the key is stripped from the URL when at the full span. */
const njdotYearRangeParam: Param<[number, number]> = {
    encode: ([a, b]) =>
        a === NJDOT_YEAR_RANGE_DEFAULT[0] && b === NJDOT_YEAR_RANGE_DEFAULT[1] ? undefined : `${a}-${b}`,
    decode: (s) => {
        if (!s) return NJDOT_YEAR_RANGE_DEFAULT
        const m = s.match(/^(\d{4})-(\d{4})$/)
        if (!m) return NJDOT_YEAR_RANGE_DEFAULT
        const a = +m[1], b = +m[2]
        return a <= b ? [a, b] : [b, a]
    },
}

export type NjdotSectionState = {
    yearRange: [number, number]
    setYearRange: (r: [number, number]) => void
    /** True when the user has narrowed the range below the full span. */
    yearRangeActive: boolean
}

const NjdotSectionContext = createContext<NjdotSectionState | null>(null)

export function NjdotSectionProvider({ children }: { children: ReactNode }) {
    const [yearRange, setYearRange] = useUrlState("ndy", njdotYearRangeParam)
    const yearRangeActive = useMemo(
        () => yearRange[0] !== NJDOT_YEAR_RANGE_DEFAULT[0]
            || yearRange[1] !== NJDOT_YEAR_RANGE_DEFAULT[1],
        [yearRange],
    )
    const value = useMemo<NjdotSectionState>(
        () => ({ yearRange, setYearRange, yearRangeActive }),
        [yearRange, setYearRange, yearRangeActive],
    )
    return <NjdotSectionContext.Provider value={value}>{children}</NjdotSectionContext.Provider>
}

/** Section-scoped filter state for the NJDOT plot + tables. Returns null
 *  when called outside `<NjdotSectionProvider>`, so consumers fall back
 *  to unfiltered behavior. */
export function useNjdotSection(): NjdotSectionState | null {
    return useContext(NjdotSectionContext)
}
