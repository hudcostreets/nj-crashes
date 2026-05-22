export type Totals = {
    tk: number
    ti: number
    tv: number
    fc: number
    ic: number
    pc: number
}

export type Crash = {
    id: number
    year: number
    cc: number
    mc: number
    case: string
    dt: string
    road: string
    cross_street: string
    sri: string | null
    mp: number | null
    ilat: number | null
    ilon: number | null
    olat: number | null
    olon: number | null
} // & Totals

/** SPA route to an individual NJDOT crash detail page (`/crash/:year/:cc/:mc/:case`). */
export function crashDetailHref(
    { year, cc, mc, case: caseStr }: Pick<Crash, "year" | "cc" | "mc" | "case">,
): string {
    return `/crash/${year}/${cc}/${mc}/${encodeURIComponent(caseStr)}`
}
