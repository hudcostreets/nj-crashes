import { fetchJson } from "@rdub/base/json/fetch"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { right } from "fp-ts/Either"
import { useRouter } from "next/router"
import { useMemo } from "react"
import { CC2MC2MN } from "@/src/county"
import { usePaginationControls } from "@/src/pagination"
import { CrashPageOpts, mkQuery } from "@/src/query"
import { ResultTable } from "@/src/result-table"
import { getNjdotCrashRows } from "@/src/use-njdot-crashes"
import css from "../result-table.module.scss"
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
  const router = useRouter()
  const { data: { crashes, total } = init, isLoading, isFetching, isError, error, } = useQuery({
    queryKey: [ NjdotCrashesId, router.asPath, page, perPage, cc, mc, ],
    queryFn: async () => {
      const q: CrashPageOpts = {
        p: page,
        pp: perPage,
        ...(cc === null ? {} : { cc }),
        ...(mc === null ? {} : { mc }),
      }
      const url = `/api/njdot/crashes?${mkQuery(q)}`
      console.log(`Fetching: ${url}`)
      return fetchJson<CrashPage>(url)
    },
    initialData: page === 0 ? init : undefined,
    enabled: page !== 0,
    placeholderData: keepPreviousData,
  })
  console.log(`njdot table: isFetching ${isFetching}, isLoading ${isLoading}`, total)
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
      isFetching={isLoading || isFetching}
      pagination={pagination}
    />
  )
}
