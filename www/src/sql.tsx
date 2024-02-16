import React, { HTMLProps, useEffect, useState } from "react";
import { getBasePath } from "@rdub/next-base/basePath";
import useSessionStorageState from "use-session-storage-state";
import css from "./sql.module.scss"
import * as Query from "@rdub/react-sql.js-httpvfs/query";
import { useSqlResult } from "@rdub/react-sql.js-httpvfs/query";
import { Result } from "@/src/sql/result";

export const UrlKey = "sql-db-url"
export const QueryKey = "sql-query"

export type Button = {
    value: string
    cb: (value: string) => void
}

export function Input({ label, defaultValue, buttons, ...inputProps }: {
    label: string
    defaultValue: string
    buttons: Button[]
} & Omit<HTMLProps<HTMLInputElement>, 'value'>) {
    const [ wipValue, setWipValue] = useState<string>(defaultValue)
    useEffect(
        () => {
            setWipValue(defaultValue)
        },
        [ defaultValue ]
    )
    return (
        <div className={css.control}>
            <label>
                {label}
                <input
                    type={"text"}
                    value={wipValue}
                    onChange={e => setWipValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.code === 'Enter') {
                            e.preventDefault();
                            buttons[0].cb(wipValue)
                        }
                    }}
                    {...inputProps}
                />
            </label>
            {
                buttons.map(({ value, cb }) => {
                    return <input
                        key={value}
                        type={"button"}
                        value={value}
                        className={css.updateButton}
                        onClick={() => {
                            cb(wipValue)
                        }}
                    />
                })
            }
        </div>
    )
}

// export const DefaultDbPath = `njsp/year-type-county.db`
// export const DefaultQuery = `select * from ytc`
export const DefaultDbPath = `njdot/crashes.db`
export const DefaultQuery = `select * from crashes where id=100000`


export default function Sql() {
    const basePath = getBasePath()
    const [ url, setUrl] = useSessionStorageState<string>(UrlKey, {defaultValue: `${basePath}/${DefaultDbPath}`})
    const [ query, setQuery] = useSessionStorageState<string>(QueryKey, {defaultValue: DefaultQuery})
    const [ requestChunkSize, setRequestChunkSize] = useState<number>(64 * 1024)
    const [ result, setResult] = useState<Query.Result<any> | null>(null)
    let doQuery: null | ((query: string) => void) = null
    try {
        console.log("try")
        doQuery = useSqlResult({url, requestChunkSize, setResult})
    } catch (e) {
        console.error("Caught error:", e)
    }
    return (
        <div>
            <Input
                label={"DB URL:"}
                buttons={[{
                    value: "Update",
                    cb: url => {
                        console.log("Updating URL:", url)
                        setUrl(url)
                        // setQuery("")
                    },
                }]}
                defaultValue={url}
            />
            <Input
                label={"Query:"}
                buttons={[
                    {
                        value: "Run",
                        cb: query => {
                            setQuery(query)
                            console.log("Running query:", query)
                            if (doQuery) doQuery(query)
                        },
                    }, {
                        value: "Explain",
                        cb: query => {
                            setQuery(query)
                            const explainQuery = `explain query plan ${query}`
                            console.log("Running query:", explainQuery)
                            if (doQuery) doQuery(explainQuery)
                        },
                    },
                ]}
                defaultValue={query}
            >
            </Input>
            <Result result={result} />
        </div>
    )
}
