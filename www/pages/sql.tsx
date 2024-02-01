import { useEffect, useState } from "react";
import { getBasePath } from "@rdub/next-base/basePath";
import { useDb } from "@rdub/react-sql.js-httpvfs/sql";
import { keys, values } from "@rdub/base/objs";

const { time, timeEnd } = console;

export default function Sql() {
    const basePath = getBasePath()
    const url = `${basePath}/njsp/year-type-county.db`
    const openTimeMsg = `time to first query result`
    const db = useDb({ url }, { time: true, openTimeMsg })
    const [ data, setData ] = useState<any[] | null>(null)
    useEffect(
        () => {
            console.log("effect:", db)
            async function runQuery() {
                if (!db) return
                const query = `select * from ytc`
                const msg = `ran query: ${query}`
                time(msg)
                const result = await db.query(query);
                timeEnd(msg)
                timeEnd(openTimeMsg)
                console.log(`result:`, result)
                setData(result)
            }
            runQuery()
        },
        [ db ]
    )
    return (
        <div>
            <table>
                <thead>
                    <tr>{
                        data?.length ? keys(data[0]).map(
                            (key, i) => (
                                <th key={i}>{key}</th>
                            )
                        ) : null
                    }</tr>
                </thead>
                <tbody>{
                    data?.map(
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
        </div>
    )
}
