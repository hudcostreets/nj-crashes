import { mapEntries } from "@rdub/base"
import { intParam, optIntParam } from "@rdub/next-params/params"
import { DefaultPageSize } from "@/src/pagination"

export type PageOpts = {
  p?: number
  pp?: number
}

export type RegionOpts = {
  cc?: number
  mc?: number
}

export type CrashPageOpts = PageOpts & RegionOpts

export const Page = {
  p: intParam(0),
  pp: intParam(DefaultPageSize),
}

export const NjspPlot = {
  cc: optIntParam()
}

export const Region = {
  ...NjspPlot,
  mc: optIntParam(),
}

export const CrashPage = {
  ...Page,
  ...Region
}

export function mkQuery<Obj extends Record<string, string | number>>(obj: Obj): string {
  return new URLSearchParams(
    mapEntries(
      obj,
      (k, v) => [ k, v.toString() ]
    )
  ).toString()
}
