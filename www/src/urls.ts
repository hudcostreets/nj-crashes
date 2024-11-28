import getBasePath from "@rdub/next-base/basePath";
import { mapValues } from "@rdub/base/objs";

export const NjspFatalAcc = "https://nj.gov/njsp/info/fatalacc/"
export const NjdotRawData = "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"

export type Local = {
    local?: boolean
}

export function getDbUrls<U extends Record<string, string>>({ local, name, urls, }: { local?: boolean, name: string, urls: U }): U {
    const cwd = process.cwd()
    const localPrefix = local ? `${cwd}/public/${name}` : `${getBasePath()}/${name}`
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/${name}/data` : localPrefix
    return mapValues(urls, (k, v) => `${prefix}/${v}`) as U
}

export type DOTUrls = {
    crashes: string
    occupants: string
    pedestrians: string
    vehicles: string
    drivers: string
    cmymc: string
}

export function getDOTDbUrls({ local }: Local = {}): DOTUrls {
    return getDbUrls({
        local,
        name: "njdot",
        urls: {
            crashes: `crashes.db`,
            occupants: `occupants.db`,
            pedestrians: `pedestrians.db`,
            vehicles: `vehicles.db`,
            drivers: `drivers.db`,
            cmymc: `cmymc.db`,
        }
    })
}

export type NjspUrls = {
    crashes: string
    crash_log: string
    ytc: string
}

export function getNJSPDbUrls({ local }: Local): NjspUrls {
    return getDbUrls({
        local,
        name: "njsp",
        urls: {
            crashes: `crashes.db`,
            crash_log: `crash-log.db`,
            ytc: `year-type-county.db`,
        }
    })
}

export type Urls = {
    njsp: NjspUrls
    dot: DOTUrls
}

export function getUrls(props: Local = {}): Urls {
    return {
        njsp: getNJSPDbUrls(props),
        dot: getDOTDbUrls(props),
    }
}
