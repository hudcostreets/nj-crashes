import { mapEntries } from "@rdub/base/objs";

export type PageOpts = {
  p?: number
  pp?: number
}

export type RegionOpts = {
  cc?: number
  mc?: number
}

export type CrashPageOpts = PageOpts & RegionOpts

export function mkQuery<Obj extends Record<string, string | number>>(obj: Obj): string {
  return new URLSearchParams(
    mapEntries(
      obj,
      (k, v) => [ k, v.toString() ]
    )
  ).toString()
}
