import { fromEntries } from "@rdub/base"
import { CCMC } from "@/src/njsp/region"
import { PageOpts } from "@/src/pagination"

export type Props = CCMC & PageOpts

export type Ids = number[]
export type IdMap<T> = Record<number, T[]>

export function idMap<T extends { crash_id: number }>(ids: Ids, els: T[]): IdMap<T> {
  const map: IdMap<T> = fromEntries(ids.map(id => [ id, [] ]))
  els.forEach(el => {
    map[el.crash_id].push(el)
  })
  return map
}
