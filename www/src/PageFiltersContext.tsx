import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { StartYear, curYear } from "@/src/constants"
import { VICTIM_TYPES, decodeVictimTypes, encodeVictimTypes, type VictimType } from "@/src/njsp/victim-types"

/** Page-wide year-range default. Spans NJSP's full range (2001 → current
 *  year); NJDOT plots clamp their x-axis to `EndYear` when the range's
 *  upper bound overshoots the last complete DOT year. */
export const YEAR_RANGE_DEFAULT: [number, number] = [StartYear, curYear]

/** Default victim-type selection: all four types. NJSP-specific — NJDOT
 *  crashes aren't broken down by victim type. */
export const NJSP_TYPES_DEFAULT: VictimType[] = [...VICTIM_TYPES]

/** `y` URL param: page-wide year range, `"<aa>-<bb>"` — 2-digit form
 *  (e.g. `"19-25"` for 2019-2025). Accepts either 2- or 4-digit input
 *  and normalizes on encode. Out-of-order pairs are swapped silently;
 *  default returns `undefined` so the key is stripped from the URL. */
const yearRangeParam: Param<[number, number]> = {
    encode: ([a, b]) =>
        a === YEAR_RANGE_DEFAULT[0] && b === YEAR_RANGE_DEFAULT[1]
            ? undefined
            : `${String(a).slice(2)}-${String(b).slice(2)}`,
    decode: (s) => {
        if (!s) return YEAR_RANGE_DEFAULT
        const m = s.match(/^(\d{2}|\d{4})-(\d{2}|\d{4})$/)
        if (!m) return YEAR_RANGE_DEFAULT
        const parse = (n: string) => n.length === 2 ? 2000 + +n : +n
        const a = parse(m[1]), b = parse(m[2])
        return a <= b ? [a, b] : [b, a]
    },
}

/** `t` URL param: NJSP victim-type filter, as single-char codes
 *  (`d`/`p`/`e`/`c`). Empty / all-four → `undefined` (key stripped). */
const njspTypesParam: Param<VictimType[]> = {
    encode: (types) => {
        const s = encodeVictimTypes(types)
        return s.length === VICTIM_TYPES.length ? undefined : s
    },
    decode: (s) => {
        if (!s) return NJSP_TYPES_DEFAULT
        const types = decodeVictimTypes(s)
        return types.length ? types : NJSP_TYPES_DEFAULT
    },
}

export type PageFiltersState = {
    yearRange: [number, number]
    setYearRange: (r: [number, number]) => void
    /** True when the user has narrowed the range below the default (full)
     *  span. Plots/tables can use this to decide whether to filter. */
    yearRangeActive: boolean
    selectedTypes: VictimType[]
    setSelectedTypes: (types: VictimType[]) => void
    /** True when fewer than all 4 victim types are selected. */
    typesActive: boolean
}

const PageFiltersContext = createContext<PageFiltersState | null>(null)

export function PageFiltersProvider({ children }: { children: ReactNode }) {
    const [yearRange, setYearRange] = useUrlState("y", yearRangeParam)
    const [selectedTypes, setSelectedTypes] = useUrlState("t", njspTypesParam)
    const yearRangeActive = useMemo(
        () => yearRange[0] !== YEAR_RANGE_DEFAULT[0]
            || yearRange[1] !== YEAR_RANGE_DEFAULT[1],
        [yearRange],
    )
    const typesActive = useMemo(
        () => selectedTypes.length !== VICTIM_TYPES.length,
        [selectedTypes],
    )
    const value = useMemo<PageFiltersState>(
        () => ({ yearRange, setYearRange, yearRangeActive, selectedTypes, setSelectedTypes, typesActive }),
        [yearRange, setYearRange, yearRangeActive, selectedTypes, setSelectedTypes, typesActive],
    )
    return <PageFiltersContext.Provider value={value}>{children}</PageFiltersContext.Provider>
}

/** Page-wide filter state (year range, NJSP victim types). Returns null
 *  when called outside `<PageFiltersProvider>` — child components can
 *  fall back to unfiltered behavior in that case. */
export function usePageFilters(): PageFiltersState | null {
    return useContext(PageFiltersContext)
}
