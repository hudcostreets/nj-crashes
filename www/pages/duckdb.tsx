import { useEffect, useRef, useState } from "react"
import { initDuckDb, runQuery } from "@rdub/duckdb-wasm/duckdb"
import { AsyncDuckDB } from "@duckdb/duckdb-wasm"
import useSessionStorageState from 'use-session-storage-state'

const QUERY_KEY = 'duckdb-query'

export default function DuckDb() {
    const [ db, setDb ] = useState<AsyncDuckDB | null>(null)
    const ref = useRef<HTMLTextAreaElement>(null);
    const [ result, setResult ] = useState<any>(null)
    const [ query, setQuery ] = useSessionStorageState<string>(QUERY_KEY, { defaultValue: "" })
    useEffect(
        () => {

            initDuckDb({ path: "s3://nj-crashes/njdot/2021.duckdb", }).then(db => setDb(db))
        },
        []
    )
    return <div>
        <textarea
            ref={ref}
            onKeyDown={e => {
                // console.log("key:", e.code, e)
                const query = ref.current?.value
                if (query && e.code === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    if (!db) {
                        console.error("no db")
                        return
                    }
                    console.log("query:", query)
                    runQuery(db, query).then(result => {
                        console.log("result:", result)
                        setResult(result)
                    })
                }
            }}
            value={query}
            onChange={e => {
                const query = ref.current?.value
                setQuery(query || "")
            }}
        />
        {
            result && <pre>{
                JSON.stringify(result, null, 2)
            }</pre>
        }
    </div>
}
