import type { State } from "@rdub/base"

export const PageSizes = [ 10, 20, 50 ]
export const DefaultPageSize = PageSizes[0]

export const PerPageKey = (id: string) => `${id}-per-page`
export const PageKey = (id: string) => `${id}-page`
export const BeforeKey = (id: string) => `${id}-before`

export type PageOpts = {
  page: number
  perPage: number
}

export const MDY = /(?<m>\d\d?)\/(?<d>\d\d?)\/(?<y>\d\d)/
export const YMD = /(?<y>\d\d\d\d)-(?<m>\d\d)-(?<d>\d\d)/

export const TZ = "America/New_York"

export type PaginationCore = State<number, 'perPage'>
export type PaginationBase = PaginationCore & State<number, 'page'>

export type Pagination = PaginationBase & {
  total: number
}

export type DatePaginationBase = PaginationCore & {
  before: string
  setBefore: (before: string) => void
  start?: string
  end?: string
}

export type DatePagination = DatePaginationBase & {
  total: number
}
