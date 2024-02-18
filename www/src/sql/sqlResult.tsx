import { keys, values } from "@rdub/base/objs";
import css from "@/src/sql-repl.module.scss";
import { fold } from "fp-ts/either";
import { Result } from "@rdub/react-sql.js-httpvfs/query";

export function SqlResult({ result }: { result: Result<Record<any, any>> | null }) {
    return result &&
        fold(
            (err: Error) => <div className={css.sqlError}>
                <h2>Error</h2>
                <pre>{err.message}</pre>
            </div>,
            (rows: Record<any, any>[]) => <table>
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
        )(result)
}
