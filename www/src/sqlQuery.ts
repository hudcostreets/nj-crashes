import * as sql from "@rdub/react-sql.js-httpvfs/sql";
import { useDb } from "@rdub/react-sql.js-httpvfs/sql";
import { useCallback, useEffect, useMemo, useState } from "react";

const { time, timeEnd } = console;

export type Data<T> = {
    kind: 'data'
    rows: T[]
}

export type Err = {
    kind: 'err'
    err: Error
}

export type Result<T> = Data<T> | Err

export type Props<T> = {
    url: string
    requestChunkSize?: number
    // query: string
}

export function useSqlQueryCallback<T = any>({ url, requestChunkSize, }: Props<T>): (query: string) => Promise<Result<T>> | null {
    const openTimeMsg = `time to query result`
    const dbProps: sql.Props = useMemo(() => ({ url, requestChunkSize }), [ url, requestChunkSize ])
    const dbOpts = useMemo(() => ({ time: true }), [])
    const db = useDb(dbProps, dbOpts)
    const callback = useCallback(
        (query: string): Promise<Result<T>> | null => {
            time(openTimeMsg)
            if (!db || !query) return null
            const msg = `ran query: ${query}`
            time(msg)
            return db.query(query)
                .then(
                    rows => {
                        timeEnd(msg)
                        timeEnd(openTimeMsg)
                        console.log(`rows:`, rows)
                        return { kind: 'data', rows: rows as T[] } as Result<T>
                    }
                )
                .catch(err => {
                    return { kind: 'err', err: err as Error }
                })
        },
        [ db ]
    )
    return callback
}

export function useSqlResult<T = any>({ url, requestChunkSize, setResult }: Props<T> & { setResult: (result: Result<T>) => void }) {
    const queryCallback = useSqlQueryCallback({ url, requestChunkSize })
    const doQuery = useCallback(
        (query: string) => {
            const result = queryCallback(query)
            if (!result) return
            result.then(res => setResult(res))
        },
        [queryCallback]
    )
    return doQuery
}

export function useSqlQuery<T = any>({ url, requestChunkSize, query }: Props<T> & { query: string }) {
    const callback = useSqlQueryCallback({ url, requestChunkSize })
    const [ result, setResult ] = useState<Result<T> | null>(null)
    useEffect(
        () => {
            const result = callback(query)
            if (result) {
                result.then(res => setResult(res))
            }
        },
        [ callback, query ]
    )
    return result
}
