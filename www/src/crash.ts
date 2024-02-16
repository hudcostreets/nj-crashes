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
    cc: number
    mc: number
    dt: string
    road: string
    cross_street: string
    mp: number | null
    ilat: number | null
    ilon: number | null
    olat: number | null
    olon: number | null
} & Totals
