import { Result } from "@/src/result";
import { useEffect, useMemo, useState } from "react";
import { fold } from "fp-ts/Either";
import css from "./pagination.module.scss";
import FirstPageIcon from '@mui/icons-material/FirstPage';
import KeyboardArrowLeft from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRight from '@mui/icons-material/KeyboardArrowRight';
import LastPageIcon from '@mui/icons-material/LastPage';
import { floor, min } from "@rdub/base/math";
import useSessionStorageState from "use-session-storage-state";

export const PageSizes = [ 10, 20, 50 ]
export const DefaultPageSize = PageSizes[0]

export const perPageKey = (id: string) => `${id}-per-page`
export const pageKey = (id: string) => `${id}-page`

export function usePaginationControls(defaults: { id: string, page?: number, perPage?: number }): PaginationBase {
    const { id } = defaults
    const [ perPage, setPerPage ] = useSessionStorageState<number>(perPageKey(id), { defaultValue: defaults.perPage ?? DefaultPageSize })
    const [ page, setPage ] = useSessionStorageState<number>(pageKey(id), { defaultValue: defaults.page ?? 0 })
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
    const [ pageTxtState, setPageTxtState ] = useState<string>((page + 1).toString())
    const [ pageTxtStateDirty, setPageTxtStateDirty ] = useState<boolean>(false)
    useEffect(
        () => {
            setPageTxtState((page + 1).toString())
            setPageTxtStateDirty(false)
        },
        [ page ]
    )
    return <div className={css.tablePagination}>
        <label className={css.curPage}>
            {page * perPage + 1}-{min(total, (page + 1) * perPage)} of {total.toLocaleString()}
        </label>
        <label className={css.pageNum}>
            Page:
            <input
                // contentEditable
                className={pageTxtStateDirty ? css.dirty : ''}
                type="number"
                value={pageTxtState}
                onChange={e => {
                    const pageTxt = e.target.value || ''
                    setPageTxtState(pageTxt)
                    const newPage = parseInt(pageTxt) - 1
                    if ((!newPage && newPage !== 0) || newPage < 0 || newPage > lastPage) {
                        setPageTxtStateDirty(true)
                        return
                    }
                    if (newPage === page && pageTxtStateDirty) {
                        setPageTxtStateDirty(false)
                    }
                    console.log(`onPageChange:`, e, newPage)
                    setPage(newPage)
                }}
            />
        </label>
        <label className={css.pageSize}>
            Page size:
            <select
                value={perPage}
                onChange={e => {
                    const newPerPage = parseInt(e.target.value)
                    console.log(`onRowsPerPageChange:`, e, newPerPage)
                    setPerPage(newPerPage)
                    const newPage = floor(page * perPage / newPerPage)
                    setPage(newPage)
                }}
            >{
                PageSizes.map(ps => <option key={ps}>{ps}</option>)
            }</select>
        </label>
        <span className={css.pageCount}>
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
