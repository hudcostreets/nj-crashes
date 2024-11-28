import { usePaginationControls } from "@/src/pagination";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CrashPageOpts, mkQuery } from "@/src/query";
import { fetchJson } from "@rdub/base/json/fetch";
import { ResultTable } from "@/src/result-table";
import { right } from "fp-ts/Either";
import { CC2MC2MN } from "@/src/county";
import { useMemo } from "react";
import css from "../result-table.module.scss"
import { getNjdotCrashRows } from "@/src/use-njdot-crashes";
import { CrashPage } from "./crash"

export const NjdotCrashesId = "njdot-crashes"

export function NjdotCrashesTable(
  {
    init,
    cc2mc2mn,
    cc = null,
    mc = null,
  }: {
    init: CrashPage
    cc2mc2mn: CC2MC2MN
    cc?: number | null
    mc?: number | null
  }
) {
  const id = useMemo(() => {
    let id = NjdotCrashesId
    if (cc !== null) {
      id += `-${cc}`
      if (mc !== null) {
        id += `-${mc}`
      }
    }
    return id
  }, [ cc, mc ])
  const paginationControls = usePaginationControls({ id, perPageId: NjdotCrashesId, })
  const { page, perPage, } = paginationControls
  const { data: { crashes, total } = init, isLoading, isError, error, } = useQuery({
    queryKey: [ NjdotCrashesId, page, perPage, cc, mc, ],
    queryFn: async () => {
      const q: CrashPageOpts = {
        p: page,
        pp: perPage,
        ...(cc === null ? {} : { cc }),
        ...(mc === null ? {} : { mc }),
      }
      return fetchJson<CrashPage>(`/api/njdot/crashes?${mkQuery(q)}`)
    },
    initialData: page === 0 ? init : undefined,
    placeholderData: keepPreviousData,
  })
  if (isLoading) return "Loading..."
  if (isError) {
    console.error("/api/njdot/crashes error:", error)
    return <div>Error!</div>
  }
  const rows = getNjdotCrashRows({ cc, mc, cc2mc2mn, crashes, }) ?? []
  const pagination = { ...paginationControls, total }
  return (
    <ResultTable
      className={css.njdotCrashesTable}
      result={right(rows)}
      pagination={pagination}
    />
  )
}
