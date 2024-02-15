import { keys, values } from "@rdub/base/objs";
import css from "@/src/sql.module.scss";
import * as sql from "@rdub/react-sql.js-httpvfs/query";

export function Result({ result }: { result: sql.Result<Record<any, any>> | null }) {
    if (!result) return null
    if (result.kind === 'data') {
        const { rows } = result
        return <table>
            <thead>
            <tr>{
                rows?.length ? keys(rows[0]).map(
                    (key, i) => (
                        <th key={i}>{key}</th>
                    )
                ) : null
            }</tr>
            </thead>
            <tbody>{
                rows?.map(
                    (row, i) => (
                        <tr key={i}>{
                            values(row).map(
                                (value, j) => (
                                    <td key={j}>{value as string | number}</td>
                                )
                            )
                        }</tr>
                    )
                )
            }</tbody>
        </table>
    } else {
        const { err } = result
        return <div className={css.sqlError}>
            <h2>Error</h2>
            <pre>{err.message}</pre>
        </div>
    }
}
