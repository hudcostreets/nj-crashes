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
import { useRouter } from "next/router";

export const NjspCrashesId = "njsp-crashes"

export function NjspCrashesTable(
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
    let id = NjspCrashesId
    if (cc !== null) {
      id += `-${cc}`
      if (mc !== null) {
        id += `-${mc}`
      }
    }
    return id
  }, [ cc, mc ])
  const paginationControls = usePaginationControls({ id, perPageId: NjspCrashesId, })
  const { page, perPage, } = paginationControls
  const router = useRouter()
  const { data: { crashes, total } = init, isFetching, isError, error, } = useQuery({
    queryKey: [ NjspCrashesId, router.asPath, page, perPage, cc, mc, ],
    queryFn: async () => {
      const q: CrashPageOpts = {
        p: page,
        pp: perPage,
        ...(cc === null ? {} : { cc }),
        ...(mc === null ? {} : { mc }),
      }
      const url = `/api/njsp/crashes?${mkQuery(q)}`
      console.log(`Fetching: ${url}`)
      return fetchJson<CrashPage>(url)
    },
    initialData: page === 0 ? init : undefined,
    enabled: page !== 0,
    placeholderData: keepPreviousData,
  })
  if (isError) {
    console.error("/api/njsp/crashes error:", error)
    return <div>Error!</div>
  }
  const rows = getNjspCrashRows({ cc, mc, cc2mc2mn, crashes, }) ?? []
  const pagination = { ...paginationControls, total }
  return (
    <ResultTable
      className={css.njspCrashesTable}
      result={right(rows)}
      isFetching={isFetching}
      pagination={pagination}
    />
  )
}
