import { mapEntries } from "@rdub/base"
import { DefaultPageSize } from "@/src/pagination"
import { Params, ParsedParams, intParam, optIntParam } from "@/src/params"

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

export function decode<P extends Params>(
  req: { query: Record<string, string | string[]> },
  params: P,
): ParsedParams<P> {
  return mapEntries(params, (k, param) => {
    let qv = req.query[k]
    if (qv instanceof Array) {
      const n = qv.length
      if (n > 1) {
        console.warn(`Multiple values for ${k}: ${qv}; using last`)
      }
      qv = qv[n - 1]
    }
    return [k, param.decode(qv)]
  }) as ParsedParams<P>
}
