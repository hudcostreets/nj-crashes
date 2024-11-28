import type { CrashPage as CrashPage0 } from "@/src/crash"

export type Totals = {
    tk: number
    ti: number
    tv: number
    fc: number
    ic: number
    pc: number
}

export type Crash0 = {
    id: number
    cc: number
    mc: number
    dt: string
    road: string
    cross_street: string
    sri: string | null
    mp: number | null
    ilat: number | null
    ilon: number | null
    olat: number | null
    olon: number | null
}

export type Occupant = {
    crash_id: number
    pos: number
    condition: number
    eject: number
    age: number
    sex: string
    inj_loc: number
    inj_type: number
}

export type Pedestrian = {
    crash_id: number
    pos: number
    condition: number
    age: number
    sex: string
    inj_loc: number
    inj_type: number
    cyclist: boolean
}

export type Vehicle = {
    crash_id: number
    damage: number
    damage_loc: number
    impact_loc: number
    departure: number
    type: number
}

export type Crash = {
    crash: Crash0
    occs: Occupant[]
    peds: Pedestrian[]
    vehs: Vehicle[]
}

export type CrashPage = CrashPage0<Crash>
