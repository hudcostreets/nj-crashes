import { Either } from "fp-ts/Either"
import { DatePagination, Pagination } from "@/src/pagination"

export type Result<T> = Either<Error, T>
export type R<T> = Either<Error, T>
export type Rs<T> = Either<Error, T[]>

export type Props = {
  className?: string
  pagination?: Pagination | DatePagination
}

export type Row = {
  key: string | number
} & Record<string, string | number>
