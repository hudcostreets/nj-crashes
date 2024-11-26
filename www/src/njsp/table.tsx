import { CrashPage } from "@/src/njsp/crash";
import { usePaginationControls } from "@/src/pagination";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CrashPageOpts, mkQuery } from "@/src/query";
import { fetchJson } from "@rdub/base/json/fetch";
import { getNjspCrashRows } from "@/src/use-njsp-crashes";
import { ResultTable } from "@/src/result-table";
import { right } from "fp-ts/Either";
import { CC2MC2MN } from "@/src/county";
import { useMemo } from "react";
import css from "../result-table.module.scss"

export const NjspCrashesId = "njsp-crashes"

export function NjspCrashesTable(
  {
    initNjsp,
    cc2mc2mn,
    cc = null,
    mc = null,
  }: {
    initNjsp: CrashPage
    cc2mc2mn: CC2MC2MN
    cc?: number | null
    mc?: number | null
  }
) {
  const id = useMemo(() => {
    let id = NjspCrashesId
    if (cc !== null) {
      id += `-${cc}`
      if (mc !== null) {
        id += `-${mc}`
      }
    }
    return id
  }, [ cc, mc ])
  const njspPaginationControls = usePaginationControls({ id, perPageId: NjspCrashesId, })
  const { page, perPage, } = njspPaginationControls
  console.log("perPage:", perPage)
  const { data: njsp = initNjsp, isLoading, isError, error, } = useQuery({
    queryKey: [ NjspCrashesId, page, perPage, cc, mc, ],
    queryFn: async () => {
      const q: CrashPageOpts = {
        p: page,
        pp: perPage,
        ...(cc === null ? {} : { cc }),
        ...(mc === null ? {} : { mc }),
      }
      const qs = mkQuery(q)
      console.log("CrashPageOpts:", q, qs)
      return fetchJson<CrashPage>(`/api/njsp/crashes?${qs}`)
    },
    initialData: page === 0 ? initNjsp : undefined,
    placeholderData: keepPreviousData,
  })
  if (isLoading) return "Loading..."
  if (isError) {
    console.error("/api/njsp/crashes error:", error)
    return <div>Error!</div>
  }
  const njspCrashes = getNjspCrashRows({ cc, mc, cc2mc2mn, crashes: njsp.crashes, }) ?? []
  const njspPagination = { ...njspPaginationControls, total: njsp.total }
  return (
    <ResultTable
      className={css.njspCrashesTable}
      result={right(njspCrashes)}
      pagination={njspPagination}
    />
  )
}
