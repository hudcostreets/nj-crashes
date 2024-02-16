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
import strftime from "strftime";
import { MC2MN } from "@/src/county";
import { Crash } from "@/src/crash";
import { fromEntries, keys, mapEntries, o2a } from "@rdub/base/objs";
import { fold } from "fp-ts/either";
import { YearStats } from "@/pages/c/[county]/[city]";

export const ColLabels = {
    id: "ID",
    dt: "Date/Time",
    mc: "City",
    casualties: "Casualties",
    road: "Road",
    cross_street: "Cross Street",
    mp: "MP",
    ll: "Lat, Lon",
    tk: "Fatalities",
    ti: "Injuries",
    tv: "Vehicles",
}
export type Col = keyof typeof ColLabels

export type Props<Row = any> = {
    // cols: Col[]
    className?: string
}

export type Row = {
    key: string | number
} & Record<string, string | number>

const YearColLabels = {
    y: "Year",
    tk: "Fatalities",
    ti: "Injuries",
    tv: "Vehicles",
    fc: "Fatal Crashes",
    ic: "Injury Crashes",
    pc: "Property Damage Crashes",
}

export function yearRows(rows: YearStats[]): Row[] {
    return rows.map(row => {
        const { y } = row
        return {
            key: y,
            ...mapEntries(
                row,
                (col, val) => [
                    YearColLabels[col],
                    col === 'y' ? val : val.toLocaleString(),
                ]
            ),
        } //as Row
    })

}

export function crashRows({ rows, cols, mc2mn }: { rows: Crash[], cols: Col[], mc2mn?: MC2MN }): Row[] {
    return rows.map(row => {
        const { id } = row
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: string | number = ''
                if (col == 'dt') {
                    txt = strftime('%-m/%-d/%-y %-I:%M%p', new Date(row.dt))
                } else if (col == 'll') {
                    const { ilat, ilon, olat, olon } = row
                    const [ lat, lon ] = ilat && ilon ? [ ilat, ilon ] : [ olat, olon ]
                    txt = (lat && lon)
                        ? `${lat?.toFixed(6)}, ${lon?.toFixed(6)}`
                        : ''
                } else if (col == 'casualties') {
                    const { tk, ti, tv } = row
                    txt = "⚰️".repeat(tk) + "🏥".repeat(ti) + "🚗".repeat(tv)
                } else if (col == 'mc') {
                    const { mc } = row
                    if (!mc2mn) {
                        throw new Error('`mc2mn` is required for `mc` col')
                    }
                    txt = mc2mn[mc]
                } else {
                    txt = row[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}

export function RowsTable({ rows, className }: Props & { rows: Row[] }) {
    // console.log("table rows:", rows, "cols:", cols)
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
