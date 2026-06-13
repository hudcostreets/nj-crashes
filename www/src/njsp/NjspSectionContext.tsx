import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { StartYear, curYear } from "@/src/constants"

/** Year-range default for the NJSP section filter bar. Spans the full
 *  range of available NJSP fatal-crash data (2001 → current year). */
export const NJSP_YEAR_RANGE_DEFAULT: [number, number] = [StartYear, curYear]

/** `nsy` URL param: NJSP-section year range, `"<a>-<b>"` (e.g. `"2019-2025"`).
 *  Out-of-order pairs are swapped silently; default is omitted from URL. */
const njspYearRangeParam: Param<[number, number]> = {
    encode: ([a, b]) =>
        a === NJSP_YEAR_RANGE_DEFAULT[0] && b === NJSP_YEAR_RANGE_DEFAULT[1] ? "" : `${a}-${b}`,
    decode: (s) => {
        if (!s) return NJSP_YEAR_RANGE_DEFAULT
        const m = s.match(/^(\d{4})-(\d{4})$/)
        if (!m) return NJSP_YEAR_RANGE_DEFAULT
        const a = +m[1], b = +m[2]
        return a <= b ? [a, b] : [b, a]
    },
}

export type NjspSectionState = {
    yearRange: [number, number]
    setYearRange: (r: [number, number]) => void
    /** True when the user has narrowed the range below the default (full)
     *  span. Plots/tables can use this to decide whether to filter. */
    yearRangeActive: boolean
}

const NjspSectionContext = createContext<NjspSectionState | null>(null)

export function NjspSectionProvider({ children }: { children: ReactNode }) {
    const [yearRange, setYearRange] = useUrlState("nsy", njspYearRangeParam)
    const yearRangeActive = useMemo(
        () => yearRange[0] !== NJSP_YEAR_RANGE_DEFAULT[0]
            || yearRange[1] !== NJSP_YEAR_RANGE_DEFAULT[1],
        [yearRange],
    )
    const value = useMemo<NjspSectionState>(
        () => ({ yearRange, setYearRange, yearRangeActive }),
        [yearRange, setYearRange, yearRangeActive],
    )
    return <NjspSectionContext.Provider value={value}>{children}</NjspSectionContext.Provider>
}

/** Section-scoped filter state for NJSP plots + table. Returns null when
 *  called outside `<NjspSectionProvider>` — child components can fall back
 *  to unfiltered behavior in that case. */
export function useNjspSection(): NjspSectionState | null {
    return useContext(NjspSectionContext)
}
