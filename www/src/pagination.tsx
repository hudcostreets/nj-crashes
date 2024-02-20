import { Result } from "@/src/result";
import { useMemo, useState } from "react";
import { fold } from "fp-ts/Either";
import css from "./pagination.module.scss";

export const PageSizes = [ 10, 20, 50 ]
export const DefaultPageSize = PageSizes[1]

export function usePaginationControls(defaults: { page?: number, perPage?: number } = {}): PaginationBase {
    const [ perPage, setPerPage ] = useState<number>(defaults.perPage ?? DefaultPageSize)
    const [ page, setPage ] = useState<number>(defaults.page ?? 0)
    return { perPage, setPerPage, page, setPage }
}

export function useResultPagination<T>(
    result: Result<T>,
    totalFn: (t: T) => number,
    {
        page, setPage,
        perPage, setPerPage,
    }: PaginationBase
): Pagination | undefined {
    const total = useMemo(
        () =>
            result
                ? fold(
                    () => null,
                    totalFn,
                )(result)
                : null,
        [ result ]
    )
    return useMemo(
        () => total === null ? undefined : { page, setPage, perPage, setPerPage, total },
        [ page, setPage, perPage, setPerPage, total ]
    )
}

import FirstPageIcon from '@mui/icons-material/FirstPage';
import KeyboardArrowLeft from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRight from '@mui/icons-material/KeyboardArrowRight';
import LastPageIcon from '@mui/icons-material/LastPage';
import { min } from "@rdub/base/math";

export type PaginationBase = {
    page: number
    setPage: (page: number) => void
    perPage: number
    setPerPage: (perPage: number) => void
}

export type Pagination = PaginationBase & {
    total: number
}

export function Pagination(
    {
        page, setPage,
        perPage, setPerPage,
        total,
    }: Pagination
) {
    const lastPage = useMemo(
        () => Math.floor(total / perPage),
        [total, perPage]
    )
    return <div className={css.tablePagination}>
        <label className={css.pageSize}>
            Page size:
            <select
                value={perPage}
                onChange={e => {
                    console.log(`onRowsPerPageChange:`, e, e.target.value)
                    setPerPage(parseInt(e.target.value))
                }}
            >{
                PageSizes.map(ps => <option key={ps}>{ps}</option>)
            }</select>
        </label>
        <span className={css.pageCount}>
            <label
                className={css.curPage}>{page * perPage + 1}-{min(total, (page + 1) * perPage)} of {total.toLocaleString()}</label>
            <button
                disabled={page === 0}
                onClick={() => {
                    console.log(`⇽: page 0`)
                    setPage(0)
                }}
            ><FirstPageIcon /></button>
            <button
                disabled={page === 0}
                onClick={() => {
                    console.log(`⇽: page ${page - 1}`)
                    setPage(page - 1)
                }}
            ><KeyboardArrowLeft /></button>
            <button
                disabled={page === lastPage}
                onClick={() => {
                    console.log(`⇾: page ${page + 1}`)
                    setPage(page + 1)
                }}
            ><KeyboardArrowRight /></button>
            <button
                disabled={page === lastPage}
                onClick={() => {
                    console.log(`⇾: page ${lastPage}`)
                    setPage(lastPage)
                }}
            ><LastPageIcon /></button>
        </span>
    </div>
}
