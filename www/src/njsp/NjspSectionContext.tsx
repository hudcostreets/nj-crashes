import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useUrlState } from "use-prms"
import type { Param } from "use-prms"
import { StartYear, curYear } from "@/src/constants"
import { VICTIM_TYPES, decodeVictimTypes, encodeVictimTypes, type VictimType } from "./victim-types"

/** Year-range default for the NJSP section filter bar. Spans the full
 *  range of available NJSP fatal-crash data (2001 → current year). */
export const NJSP_YEAR_RANGE_DEFAULT: [number, number] = [StartYear, curYear]

/** Default victim-type selection: all four types. */
export const NJSP_TYPES_DEFAULT: VictimType[] = [...VICTIM_TYPES]

/** `nsy` URL param: NJSP-section year range, `"<a>-<b>"` (e.g. `"2019-2025"`).
 *  Out-of-order pairs are swapped silently; default returns `undefined` so the
 *  key is stripped from the URL entirely (not `?nsy=`). */
const njspYearRangeParam: Param<[number, number]> = {
    encode: ([a, b]) =>
        a === NJSP_YEAR_RANGE_DEFAULT[0] && b === NJSP_YEAR_RANGE_DEFAULT[1] ? undefined : `${a}-${b}`,
    decode: (s) => {
        if (!s) return NJSP_YEAR_RANGE_DEFAULT
        const m = s.match(/^(\d{4})-(\d{4})$/)
        if (!m) return NJSP_YEAR_RANGE_DEFAULT
        const a = +m[1], b = +m[2]
        return a <= b ? [a, b] : [b, a]
    },
}

/** `nst` URL param: NJSP-section victim-type filter, as single-char codes
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

export type NjspSectionState = {
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

const NjspSectionContext = createContext<NjspSectionState | null>(null)

export function NjspSectionProvider({ children }: { children: ReactNode }) {
    const [yearRange, setYearRange] = useUrlState("nsy", njspYearRangeParam)
    const [selectedTypes, setSelectedTypes] = useUrlState("nst", njspTypesParam)
    const yearRangeActive = useMemo(
        () => yearRange[0] !== NJSP_YEAR_RANGE_DEFAULT[0]
            || yearRange[1] !== NJSP_YEAR_RANGE_DEFAULT[1],
        [yearRange],
    )
    const typesActive = useMemo(
        () => selectedTypes.length !== VICTIM_TYPES.length,
        [selectedTypes],
    )
    const value = useMemo<NjspSectionState>(
        () => ({ yearRange, setYearRange, yearRangeActive, selectedTypes, setSelectedTypes, typesActive }),
        [yearRange, setYearRange, yearRangeActive, selectedTypes, setSelectedTypes, typesActive],
    )
    return <NjspSectionContext.Provider value={value}>{children}</NjspSectionContext.Provider>
}

/** Section-scoped filter state for NJSP plots + table. Returns null when
 *  called outside `<NjspSectionProvider>` — child components can fall back
 *  to unfiltered behavior in that case. */
export function useNjspSection(): NjspSectionState | null {
    return useContext(NjspSectionContext)
}
