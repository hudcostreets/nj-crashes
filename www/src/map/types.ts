// Types for map crash data

export type Crash = {
    dt: Date
    sri: string
    mp: number
    lon: number
    lat: number
    city: string
    tk: number
    ti: number
    pk: number
    pi: number
    severity: 'p' | 'i' | 'f'
    tv: number
}

export type CrashDiff = Crash & {
    oilon: number
    oilat: number
}

export type LL = { lat: number; lng: number }
