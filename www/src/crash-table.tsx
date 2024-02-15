import css from "@/src/sql/result.module.scss";
import * as sql from "@rdub/react-sql.js-httpvfs/query";
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

export const ColLabels = {
    id: "ID",
    dt: "Date/Time",
    mc: "City",
    casualties: "Casualties",
    road: "Road",
    cross_street: "Cross Street",
    mp: "MP",
    ll: "Lat, Lon",
}
export type Col = keyof typeof ColLabels

export type Props<Row = any> = {
    result: sql.Result<Row> | null
    cols: Col[]
    mc2mn?: MC2MN
    className?: string
}

export function CrashTable({ result, cols, mc2mn, className }: Props) {
    if (!result) return null
    if (result.kind === 'data') {
        const { rows } = result
        // const hasLL = cols.includes('ll')
        // const hasCasualties = cols.includes('casualties')
        return (
            <TableContainer component={Paper} className={className}>
                <Table sx={{ minWidth: 450 }} size={"small"} aria-label="simple table">
                    <TableHead className={css.tableHead}>
                        <TableRow>{
                            cols.map(col =>
                                <TableCell key={col} align="right">{ColLabels[col]}</TableCell>
                            )
                        }</TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map(row => {
                            const { id } = row
                            return (
                                <TableRow
                                    key={id}
                                    sx={{'&:last-child td, &:last-child th': {border: 0}}}
                                >{
                                    cols.map(col => {
                                        let txt: string = ''
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
                                            txt = row[col]
                                        }
                                        return <TableCell key={col} align="right">{txt}</TableCell>
                                    })
                                }</TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
        )
    } else {
        const { err } = result
        return <div className={css.sqlError}>
            <h2>Error</h2>
            <pre>{err.message}</pre>
        </div>
    }
}
