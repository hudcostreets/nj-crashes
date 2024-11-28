import moment from 'moment-timezone'
import { Dispatch, useCallback, useContext, useEffect, useMemo, useState } from "react";
import css from "./pagination.module.scss";
import FirstPageIcon from '@mui/icons-material/FirstPage';
import KeyboardArrowLeft from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRight from '@mui/icons-material/KeyboardArrowRight';
import LastPageIcon from '@mui/icons-material/LastPage';
import { floor, min } from "@rdub/base/math";
import useSessionStorageState from "use-session-storage-state";
import strftime from "strftime";
import { ArrowForward, ArrowForwardIos, SvgIconComponent } from "@mui/icons-material";
import { Tooltip } from "@mui/material";
import { useCookie } from "@/src/use-cookie";
import { CookiesContext } from './cookies';
import { State } from "@rdub/base/state";

export const PageSizes = [ 10, 20, 50 ]
export const DefaultPageSize = PageSizes[0]

export const PerPageKey = (id: string) => `${id}-per-page`
export const PageKey = (id: string) => `${id}-page`
export const BeforeKey = (id: string) => `${id}-before`

export function usePaginationControls({ id, perPageId, ...defaults }: { id: string, perPageId?: string, page?: number, perPage?: number, }): PaginationBase {
    const cookies = useContext(CookiesContext)
    const key = PerPageKey(perPageId ?? id)
    const cookie = cookies[key]
    const init = cookie ? parseInt(cookie) : (defaults.perPage ?? DefaultPageSize)
    const [ perPageCookie, setPerPageCookie ] = useCookie(key)
    const perPage = useMemo(() => perPageCookie ? parseInt(perPageCookie) : init, [ perPageCookie, init ])
    console.log(`key ${key}, perPage: ${perPage}, perPageCookie: ${perPageCookie}, cookies:`, cookies)
    const setPerPage = useCallback(
        (perPage: number) => { setPerPageCookie(perPage === init ? undefined : perPage.toString()) },
        [ setPerPageCookie ]
    )
    const [ page, setPage ] = useSessionStorageState<number>(PageKey(id), { defaultValue: defaults.page ?? 0 })
    return { perPage, setPerPage, page, setPage }
}

export const MDY = /(?<m>\d\d?)\/(?<d>\d\d?)\/(?<y>\d\d)/
export const YMD = /(?<y>\d\d\d\d)-(?<m>\d\d)-(?<d>\d\d)/

export function useDatePaginationControls(
    defaults: {
        id: string
        before?: string
        perPage?: number
    },
    { start, end }: {
        start?: string
        end?: string
    }
): DatePaginationBase {
    const { id } = defaults
    const [ perPage, setPerPage ] = useSessionStorageState<number>(
        PerPageKey(id),
        { defaultValue: defaults.perPage ?? DefaultPageSize }
    )
    const [ before, _setBefore ] = useSessionStorageState<string>(
        BeforeKey(id),
        {
            defaultValue: end ?? defaults.before ?? strftime("%Y-%m-%d", new Date()),
            serializer: {
                parse: (s: string) => {
                    if (!s.match(YMD)) {
                        console.warn("useDatePaginationControls: invalid date", s)
                        return end ?? strftime("%Y-%m-%d", new Date())
                    }
                    return s
                },
                stringify: (s: unknown) => {
                    const str = s as string
                    if (!str.match(YMD)) {
                        console.warn("useDatePaginationControls: invalid date", str)
                        return end ?? strftime("%Y-%m-%d", new Date())
                    }
                    return str
                }
            }
        }
    )
    const max = useMemo(() => end ?? strftime("%Y-%m-%d", new Date()), [ end ])
    const setBefore = useCallback(
        (before: string) => {
            console.log("setBefore:", before)
            if (!before.match(YMD)) {
                console.warn("setBefore: invalid date", before)
            } else if (before > max) {
                _setBefore(max)
            } else {
                _setBefore(before)
            }
        },
        [ _setBefore, max ]
    )
    return { perPage, setPerPage, before, setBefore, start, end }
}

export type PaginationCore = State<number, 'perPage'>
export type PaginationBase = PaginationCore & State<number, 'page'>

export type PageOpts = {
  page: number
  perPage: number
}

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

export const TZ = "America/New_York"

export function Button(
    { cur, disabled, add, unit, Icon, setBefore, className, }: {
        cur: string
        disabled?: boolean
        Icon: SvgIconComponent
        add: boolean
        unit: 'day' | 'month' | 'year'
        setBefore: Dispatch<string>
        className?: string
    }
) {
    return (
        <Tooltip title={add ? `Forward 1 ${unit}` : `Back 1 ${unit}`}>
            <span>
                <button
                    disabled={disabled}
                    onClick={() => {
                        let m = moment.tz(cur, TZ)
                        if (add)
                            m = m.add(1, unit)
                        else
                            m = m.subtract(1, unit)
                        const nxt = m.format("YYYY-MM-DD")
                        console.log(`new date: ${nxt}`)
                        setBefore(nxt)
                    }}
                >
                    <Icon className={`${className ?? ""} ${add ? css.left : ""}`} />
                </button>
            </span>
        </Tooltip>
    )
}

export function DatePagination(
    {
        before, setBefore,
        start, end,
        perPage, setPerPage,
        total,
    }: DatePagination
) {
    console.log("DatePagination: before", before, "end:", end)
    const [dateTxtState, setDateTxtState] = useState<string>(before)
    const [dateTxtStateDirty, setDateTxtStateDirty] = useState<boolean>(false)
    const mStr = useMemo(() => moment.tz(before, TZ).format("M/D/YY"), [ before ])
    useEffect(
        () => {
            setDateTxtState(mStr)
            setDateTxtStateDirty(false)
        },
        [ before, mStr ]
    )
    const fwdDisabled = useMemo(
        () => before >= (end ?? strftime("%Y-%m-%d", new Date())),
        [ before, end ]
    )
    return <div className={css.tablePagination}>
        <label className={css.curPage}>{total.toLocaleString()} total</label>
        <label className={css.pageSize}>
            Page size:
            <select
                value={perPage}
                onChange={e => {
                    const newPerPage = parseInt(e.target.value)
                    console.log(`onRowsPerPageChange:`, e, newPerPage)
                    setPerPage(newPerPage)
                }}
            >{
                PageSizes.map(ps => <option key={ps}>{ps}</option>)
            }</select>
        </label>
        <label className={css.beforeDate}>
            On or before:
            <input
                className={dateTxtStateDirty ? css.dirty : ''}
                type="text"
                value={dateTxtState}
                onChange={e => {
                    const dateTxt = e.target.value || ''
                    setDateTxtState(dateTxt)
                    const match = dateTxt.match(MDY)
                    if (!match) {
                        setDateTxtStateDirty(true)
                        return
                    }
                    const { y, m, d } = match.groups as { y: string, m: string, d: string }
                    let ymd = `20${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
                    if (end && ymd > end) {
                        ymd = end
                    }
                    if (dateTxt == before && dateTxtStateDirty) {
                        setDateTxtStateDirty(false)
                    }
                    console.log(`new "before" date:`, ymd)
                    setBefore(ymd)
                }}
            />
        </label>
        <span className={css.pageCount}>
            <Tooltip title={`Seek to end (${end})`}>
                <span>
                    <button
                        disabled={fwdDisabled}
                        onClick={() => {
                            console.log(`⇾: end`, end)
                            setBefore(end ?? strftime("%Y-%m-%d", new Date()))
                        }}
                    >
                        <FirstPageIcon/>
                    </button>
                </span>
            </Tooltip>
            <Button cur={before} Icon={ArrowForward} add={true} unit={'year'} setBefore={setBefore} disabled={fwdDisabled}/>
            <Button cur={before} Icon={ArrowForwardIos} add={true} unit={'month'} setBefore={setBefore} className={css.reduce} disabled={fwdDisabled}/>
            <Button cur={before} Icon={KeyboardArrowRight} add={true} unit={'day'} setBefore={setBefore} disabled={fwdDisabled}/>
            <Button cur={before} Icon={KeyboardArrowRight} add={false} unit={'day'} setBefore={setBefore}/>
            <Button cur={before} Icon={ArrowForwardIos} add={false} unit={'month'} setBefore={setBefore} className={css.reduce}/>
            <Button cur={before} Icon={ArrowForward} add={false} unit={'year'} setBefore={setBefore}/>
            {/* TODO: "last page", seek to earliest date, order by dt asc, reverse during display logic */}
        </span>
    </div>
}
