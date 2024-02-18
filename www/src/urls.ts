import { getBasePath } from "@rdub/next-base/basePath";

export type Urls = {
    crashes: string
    occupants: string
    pedestrians: string
    vehicles: string
    drivers: string
    cmym: string
}

export function getDbUrls(): Urls {
    const basePath = getBasePath()
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/njdot/data` : `${basePath}/njdot`
    return {
        crashes: `${prefix}/crashes.db`,
        occupants: `${prefix}/occupants.db`,
        pedestrians: `${prefix}/pedestrians.db`,
        vehicles: `${prefix}/vehicles.db`,
        drivers: `${prefix}/drivers.db`,
        cmym: `${prefix}/cmym.db`,
    }
}
