import { getBasePath } from "@rdub/next-base/basePath";

export const NjspFatalAcc = "https://nj.gov/njsp/info/fatalacc/"
export const NjdotRawData = "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"

export type DOTUrls = {
    crashes: string
    occupants: string
    pedestrians: string
    vehicles: string
    drivers: string
    cmym: string
    cmymc: string
}

export function getDOTDbUrls(): DOTUrls {
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/njdot/data` : `${getBasePath()}/njdot`
    return {
        crashes: `${prefix}/crashes.db`,
        occupants: `${prefix}/occupants.db`,
        pedestrians: `${prefix}/pedestrians.db`,
        vehicles: `${prefix}/vehicles.db`,
        drivers: `${prefix}/drivers.db`,
        cmym: `${prefix}/cmym.db`,
        cmymc: `${prefix}/cmymc.db`,
    }
}

export type NjspUrls = {
    crashes: string
    crash_log: string
    ytc: string
}

export function getNJSPDbUrls(): NjspUrls {
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/njsp/data` : `${getBasePath()}/njsp`
    return {
        crashes: `${prefix}/crashes.db`,
        crash_log: `${prefix}/crash-log.db`,
        ytc: `${prefix}/year-type-county.db`,
    }
}

export type Urls = {
    njsp: NjspUrls
    dot: DOTUrls
}

export function getUrls(): Urls {
    return {
        njsp: getNJSPDbUrls(),
        dot: getDOTDbUrls(),
    }
}
