import { mapValues } from "@rdub/base"
import getBasePath from "@rdub/next-base/basePath"
import { DotPqts, NjspCrashesPqt } from "@/server/paths"

export const NjspFatalAcc = "https://nj.gov/njsp/info/fatalacc/"
export const NjdotRawData = "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"

export type Loc = "local" | "fetch" | "s3"

export function getDbUrls<U extends Record<string, string>>({ loc, name, urls, }: { loc?: Loc, name: string, urls: U }): U & { loc: Loc } {
  const cwd = process.cwd()
  if (process.env['S3_DBS']) {
    loc = "s3"
  } else if (process.env['LOCAL_DBS']) {
    loc = "local"
  } else if (process.env['FETCH_DBS']) {
    loc = "fetch"
  } else if (!loc) {
    loc = "local"
  }
  let prefix: string
  if (loc === "local") {
    prefix = `${cwd}/public/${name}`
  } else if (loc === "fetch") {
    prefix = `${getBasePath()}/${name}`
  } else if (loc === "s3") {
    prefix = `https://nj-crashes.s3.amazonaws.com/${name}/data`
  } else {
    throw new Error(`Unknown loc: ${loc}`)
  }
  return {
    ...mapValues(urls, (k, v) => `${prefix}/${v}`) as U,
    loc,
  }
}

export type DotTypeUrls = {
    crashes: string
    occupants: string
    pedestrians: string
    vehicles: string
    drivers: string
}
export type DotSqlUrls = DotTypeUrls & {
    cmymc: string
}
export type DotPqtUrls = DotTypeUrls & {
    cmyc: string
    cyc: string
    yc: string
}
export type DotUrls = DotSqlUrls & DotPqtUrls

export function getDOTDbUrls(loc?: Loc): DotUrls {
  const urls = getDbUrls({
    loc,
    name: "njdot",
    urls: {
      crashes: `crashes.db`,
      occupants: `occupants.db`,
      pedestrians: `pedestrians.db`,
      vehicles: `vehicles.db`,
      drivers: `drivers.db`,
      cmymc: `cmymc.db`,
      cmyc: 'cmyc.parquet',
      cyc: 'cyc.parquet',
      yc: 'yc.parquet',
    }
  })
  if (urls.loc === "local") {
    return {
      ...urls,
      ...DotPqts
    }
  } else {
    return urls
  }
}

export type NjspUrls = {
    loc: Loc
    crashes: string
    crashesPqt: string
    crash_log: string
    ytc: string
}

export function getNJSPDbUrls(loc?: Loc): NjspUrls {
  const urls = getDbUrls({
    loc,
    name: "njsp",
    urls: {
      crashes: `crashes.db`,
      crashesPqt: `crashes.parquet`,
      crash_log: `crash-log.db`,
      ytc: `year-type-county.db`,
    }
  })
  if (urls.loc === "local") {
    urls.crashesPqt = NjspCrashesPqt
  }
  return urls
}

export type CrimeUrls = {
  loc: Loc
  homicides: string
  county_homicides: string
}

export function getCrimeDbUrls(loc?: Loc) {
  return getDbUrls({
    loc,
    name: "crime",
    urls: {
      homicides: `homicides.parquet`,
      county_homicides: `county-homicides.parquet`,
    }
  })
}

export type Urls = {
  njsp: NjspUrls
  dot: DotUrls
  crime: CrimeUrls
}

export function getUrls({ loc }: { loc?: Loc } = {}): Urls {
  return {
    njsp: getNJSPDbUrls(loc),
    dot: getDOTDbUrls(loc),
    crime: getCrimeDbUrls(loc),
  }
}

export const urls = getUrls()
