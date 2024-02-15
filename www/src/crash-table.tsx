import css from "@/src/sql/result.module.scss";
import * as sql from "@/src/sqlQuery";
import TableContainer from "@mui/material/TableContainer";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableBody from "@mui/material/TableBody";
import * as React from "react";
import strftime from "strftime";

export function CrashTable({ result, mc2mn }: { result: sql.Result<any> | null, mc2mn: any }) {
    if (!result) return null
    if (result.kind === 'data') {
        const { rows } = result
        return (
            <TableContainer component={Paper}>
                <Table sx={{ minWidth: 450 }} size={"small"} aria-label="simple table">
                    <TableHead className={css.tableHead}>
                        <TableRow>
                            {/*<TableCell>ID</TableCell>*/}
                            <TableCell align="right">Date/Time</TableCell>
                            <TableCell align="right">City</TableCell>
                            <TableCell align="right">Casualties</TableCell>
                            <TableCell align="right">Road</TableCell>
                            <TableCell align="right">Cross Street</TableCell>
                            <TableCell align="right">MP</TableCell>
                            <TableCell align="right">Lat, Lon</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map(({ id, dt, severity, cc, mc, tk, ti, pk, pi, tv, road, cross_street, mp, ilat, ilon, olat, olon }) => {
                            const [ lat, lon ] = ilat && ilon ? [ ilat, ilon ] : [ olat, olon ]
                            return (
                                <TableRow
                                    key={id}
                                    sx={{'&:last-child td, &:last-child th': {border: 0}}}
                                >
                                    {/*<TableCell component="th" scope="row">{id}</TableCell>*/}
                                    <TableCell
                                        align="right">{strftime('%-m/%-d/%-y %-I:%M%p', new Date(dt))}</TableCell>
                                    <TableCell align="right">{mc2mn[mc]}</TableCell>
                                    <TableCell
                                        align="right">{"⚰️".repeat(tk) + "🏥".repeat(ti) + "🚗".repeat(tv)}</TableCell>
                                    <TableCell align="right">{road}</TableCell>
                                    <TableCell align="right">{cross_street}</TableCell>
                                    <TableCell align="right">{mp}</TableCell>
                                    <TableCell align="right">{
                                        (lat && lon)
                                            ? `${lat?.toFixed(6)}, ${lon?.toFixed(6)}`
                                            : ''
                                    }</TableCell>
                                </TableRow>
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
