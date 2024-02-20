import css from "./result-table.module.scss";
import { Result } from "@rdub/react-sql.js-httpvfs/query";
import TableContainer from "@mui/material/TableContainer";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableBody from "@mui/material/TableBody";
import * as React from "react";
import { keys, o2a } from "@rdub/base/objs";
import { fold } from "fp-ts/either";
import { TablePagination } from "@mui/base";
import { TableFooter } from "@mui/material";
import { useMemo } from "react";
import FirstPageIcon from '@mui/icons-material/FirstPage';
import KeyboardArrowLeft from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRight from '@mui/icons-material/KeyboardArrowRight';
import LastPageIcon from '@mui/icons-material/LastPage';
import { min } from "@rdub/base/math";

export type Pagination = {
    page: number
    setPage: (page: number) => void
    perPage: number
    total: number
    setPerPage: (perPage: number) => void
}

export function Pagination(
    {
        page, setPage,
        perPage, setPerPage,
        total,
    }: Pagination
) {
    const lastPage = useMemo(
        () => {
            const lastPage = Math.floor(total / perPage)
            return lastPage
        },
        [total, perPage]
    )
    return <div className={css.tablePagination}>
        <label className={css.pageSize}>
            Page size:
            <select
                onChange={e => {
                    console.log(`onRowsPerPageChange:`, e, e.target.value)
                    setPerPage(parseInt(e.target.value))
                }}
            >
                <option>10</option>
                <option>25</option>
                <option>100</option>
            </select>
        </label>
        <span className={css.pageCount}>
            <label
                className={css.curPage}>{page * perPage + 1}-{min(total, (page + 1) * perPage)} of {total.toLocaleString()}</label>
            <button
                disabled={page === 0}
                onClick={e => {
                    console.log(`⇽: page 0`)
                    setPage(0)
                }}
            ><FirstPageIcon /></button>
            <button
                disabled={page === 0}
                onClick={e => {
                    console.log(`⇽: page ${page - 1}`)
                    setPage(page - 1)
                }}
            ><KeyboardArrowLeft /></button>
            <button
                disabled={page === lastPage}
                onClick={e => {
                    console.log(`⇾: page ${page + 1}`)
                    setPage(page + 1)
                }}
            ><KeyboardArrowRight /></button>
            <button
                disabled={page === lastPage}
                onClick={e => {
                    console.log(`⇾: page ${lastPage}`)
                    setPage(lastPage)
                }}
            ><LastPageIcon /></button>
        </span>
    </div>
}

export type Props<Row = any> = {
    className?: string
    pagination?: Pagination
}

export type Row = {
    key: string | number
} & Record<string, string | number>

export function RowsTable(
    {
        rows,
        colTitles,
        className,
        pagination,
    }: Props & {
        rows: Row[]
        colTitles?: Record<string, string>
    }) {
    return (
        <TableContainer component={Paper} className={className}>
            <Table stickyHeader sx={{minWidth: 450}} size={"small"} aria-label="simple table">
                <TableHead className={css.tableHead}>
                    <TableRow>{
                        keys(rows[0]).map(
                            key =>
                                key !== 'key' &&
                                <TableCell
                                    key={key}
                                    align="right"
                                    title={colTitles?.[key]}
                                >
                                    {key}
                                </TableCell>
                        )
                    }</TableRow>
                </TableHead>
                <TableBody>
                    {rows.map(row => {
                        const { key } = row
                        return (
                            <TableRow
                                key={key}
                                sx={{'&:last-child td, &:last-child th': {border: 0}}}
                            >{
                                o2a(row, (col, val) =>
                                    col !== 'key' && <TableCell key={col} align="right">{val}</TableCell>
                                )
                            }</TableRow>
                        )
                    })}
                </TableBody>
                {
                    pagination &&
                    <TableFooter>
                        <TableRow>
                            <td colSpan={6}>
                                <Pagination {...pagination} />
                            </td>
                        </TableRow>
                    </TableFooter>
                }
            </Table>
        </TableContainer>
    )
}

export function ResultTable(
    { result, colTitles, className, pagination, }: Props & {
        result: Result<Row>
        colTitles ? : Record<string, string>
    }
) {
    return fold(
        (err: Error) =>
            <div className={css.sqlError}>
                <h2>Error</h2>
                <pre>{err.message}</pre>
            </div>,
        (rows: Row[]) =>
            <RowsTable
                rows={rows}
                className={className}
                colTitles={colTitles}
                pagination={pagination}
            />
    )(result)
}
