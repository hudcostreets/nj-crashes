import { getBasePath } from "@rdub/next-base/basePath";

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

export function getNJSPDbUrls() {
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/njsp/data` : `${getBasePath()}/njsp`
    return {
        crashes: `${prefix}/njsp/data/crashes.db`,
        crash_log: `${prefix}/njsp/data/crash-log.db`,
    }
}
