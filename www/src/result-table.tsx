import css from "@/src/sql/result.module.scss";
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

export type Props<Row = any> = {
    className?: string
}

export type Row = {
    key: string | number
} & Record<string, string | number>

export function RowsTable({ rows, className }: Props & { rows: Row[] }) {
    return (
        <TableContainer component={Paper} className={className}>
            <Table sx={{ minWidth: 450 }} size={"small"} aria-label="simple table">
                <TableHead className={css.tableHead}>
                    <TableRow>{
                        keys(rows[0]).map(key =>
                            key !== 'key' && <TableCell key={key} align="right">{key}</TableCell>
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
            </Table>
        </TableContainer>
    )
}

export function ResultTable({ result, className }: Props & { result: Result<Row> }) {
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
            />
    )(result)
}
