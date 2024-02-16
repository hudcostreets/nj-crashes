import { getBasePath } from "@rdub/next-base/basePath";

export type Urls = {
    crashes: string
    cmym: string
}

export function getDbUrls(): Urls {
    const basePath = getBasePath()
    const prefix = process.env['S3_DBS'] ? `https://nj-crashes.s3.amazonaws.com/njdot/data` : `${basePath}/njdot`
    return {
        crashes: `${prefix}/crashes.db`,
        cmym: `${prefix}/cmym.db`,
    }
}
