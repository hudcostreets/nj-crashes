import css from "./result-table.module.scss";
import TableContainer from "@mui/material/TableContainer";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableBody from "@mui/material/TableBody";
import * as React from "react";
import { keys, o2a } from "@rdub/base/objs";
import { Either, fold } from "fp-ts/Either";
import { TableFooter } from "@mui/material";
import { DatePagination, Pagination } from "@/src/pagination";
import { Tooltip } from "./tooltip";

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
        <TableContainer component={Paper} style={{ boxShadow: "none", }} className={`${css.rowsTable} ${className || ""}`}>
            <Table stickyHeader sx={{minWidth: 450}} size={"small"} aria-label="simple table">
                <TableHead className={css.tableHead}>
                    <TableRow>{
                        keys(rows[0] ?? {}).map(
                            key =>
                                key !== 'key' &&
                                <Tooltip title={colTitles?.[key]} key={key} arrow>
                                    <TableCell align="right" className={css.noselect}>{key}</TableCell>
                                </Tooltip>
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
                            <td colSpan={6}>{
                                ('before' in pagination)
                                    ? <DatePagination {...pagination} />
                                    : <Pagination {...pagination} />
                            }</td>
                        </TableRow>
                    </TableFooter>
                }
            </Table>
        </TableContainer>
    )
}

export function ResultTable(
    { result, colTitles, className, pagination, }: Props & {
        result: Rs<Row>
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
                className={`${css.crashesTable} ${className || ""}`}
                colTitles={colTitles}
                pagination={pagination}
            />
    )(result)
}
