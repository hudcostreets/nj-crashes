import React, { createRef, HTMLProps, useEffect, useState } from "react";
import useSessionStorageState from "use-session-storage-state";
import css from "./sql-repl.module.scss"
import { Result, useSqlResult } from "@rdub/react-sql.js-httpvfs/query";
import { SqlResult } from "@/src/sql/sqlResult";
import { getDbUrls } from "@/src/urls";

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
} & Omit<HTMLProps<HTMLTextAreaElement>, 'value'>) {
    const [ wipValue, setWipValue] = useState<string>(defaultValue)
    useEffect(
        () => {
            setWipValue(defaultValue)
        },
        [ defaultValue ]
    )
    const [ scrollHeight, setScrollHeight ] = useState<number | null>(null)
    const ref = createRef<HTMLTextAreaElement>()
    useEffect(
        () => {
            if (ref.current) {
                console.log("set initial scrollHeight")
                setScrollHeight(ref.current.scrollHeight)
            }
        },
        [ref.current]
    )
    return (
        <div className={css.control}>
            <label>
                {label}
                <textarea
                    ref={ref}
                    style={scrollHeight ? { height: `${scrollHeight}px` } : {}}
                    // type={"text"}
                    value={wipValue}
                    onInput={e => {
                        setScrollHeight((e.target as HTMLTextAreaElement).scrollHeight)
                    }}
                    onChange={e => setWipValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.code === 'Enter' && e.shiftKey) {
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
export const DefaultDbPath = getDbUrls().crashes
export const DefaultQuery = `select * from crashes where id=100000`

/*
select
    co.crash_id,
    sum(case when p.condition=1 and not p.cyclist then 1 else 0 end) as pedk,
    sum(case when p.condition>1 and not p.cyclist then 1 else 0 end) as pedi,
    sum(case when p.condition=1 and p.cyclist then 1 else 0 end) as bk,
    sum(case when p.condition>1 and p.cyclist then 1 else 0 end) as bi,
    co.*
from (
select
    c.id as crash_id,
    count(*) as num_occupants,
    sum(case when o.condition=1 and o.pos=1 then 1 else 0 end) as dk,
    sum(case when o.condition>1 and o.condition<5 and o.pos=1 then 1 else 0 end) as di,
    sum(case when o.condition=1 and o.pos>1 then 1 else 0 end) as ok,
    sum(case when o.condition>1 and o.condition<5 and o.pos>1 then 1 else 0 end) as oi,
    c.*
from (
    select * from crashes
    where severity='f'
    order by dt desc limit 2
) c
left join occupants o on c.id=o.crash_id
group by o.crash_id
) co
left join pedestrians p on co.crash_id=p.crash_id
group by p.crash_id
*/

/*
select
  p.*,
  o.*,
  c.*
from (
  select * from crashes
  where severity='f'
  order by dt desc limit 2
) c
left join (
  select
    crash_id,
    sum(case when p.condition=1 and not p.cyclist then 1 else 0 end) as pedk,
    sum(case when p.condition>1 and not p.cyclist then 1 else 0 end) as pedi,
    sum(case when p.condition=1 and p.cyclist then 1 else 0 end) as bk,
    sum(case when p.condition>1 and p.cyclist then 1 else 0 end) as bi
  from pedestrians p
  group by crash_id
) p
on c.id=p.crash_id
left join (
  select
    crash_id,
    sum(case when o.condition=1 and o.pos=1 then 1 else 0 end) as dk,
    sum(case when o.condition>1 and o.condition<5 and o.pos=1 then 1 else 0 end) as di,
    sum(case when o.condition=1 and o.pos>1 then 1 else 0 end) as ok,
    sum(case when o.condition>1 and o.condition<5 and o.pos>1 then 1 else 0 end) as oi
  from occupants o
  group by crash_id
) o on c.id=o.crash_id
 */


/*
CREATE TEMP TABLE IF NOT EXISTS tmp_c AS
SELECT * FROM crashes
WHERE severity='f'
ORDER BY dt DESC
LIMIT 10;

CREATE TEMP TABLE IF NOT EXISTS tmp_o AS
SELECT
    crash_id,
    SUM(CASE WHEN o.condition = 1 AND o.pos = 1 THEN 1 ELSE 0 END) AS dk,
    SUM(CASE WHEN o.condition > 1 AND o.condition < 5 AND o.pos = 1 THEN 1 ELSE 0 END) AS di,
    SUM(CASE WHEN o.condition = 1 AND o.pos > 1 THEN 1 ELSE 0 END) AS ok,
    SUM(CASE WHEN o.condition > 1 AND o.condition < 5 AND o.pos > 1 THEN 1 ELSE 0 END) AS oi
  FROM occupants o
  JOIN tmp_c c2 ON o.crash_id = c2.id
  GROUP BY crash_id;

CREATE TEMP TABLE IF NOT EXISTS tmp_p AS
SELECT
    crash_id,
    sum(case when p.condition=1 and not p.cyclist then 1 else 0 end) as pedk,
    sum(case when p.condition>1 and not p.cyclist then 1 else 0 end) as pedi,
    sum(case when p.condition=1 and p.cyclist then 1 else 0 end) as bk,
    sum(case when p.condition>1 and p.cyclist then 1 else 0 end) as bi
  FROM pedestrians p
  JOIN tmp_c c2 ON p.crash_id = c2.id
  GROUP BY crash_id;

SELECT
  c.id as crash_id,
  o.dk, o.di, o.ok, o.oi,
  p.pedk, p.pedi, p.bk, p.bi,
  c.*
FROM tmp_c c
LEFT JOIN tmp_o o ON c.id = o.crash_id
LEFT JOIN tmp_p p ON c.id = p.crash_id
*/

export default function SqlRepl() {
    const [ url, setUrl] = useSessionStorageState<string>(UrlKey, {defaultValue: `${DefaultDbPath}`})
    const [ query, setQuery] = useSessionStorageState<string>(QueryKey, {defaultValue: DefaultQuery})
    const [ requestChunkSize, setRequestChunkSize] = useState<number>(64 * 1024)
    const [ result, setResult] = useState<Result<any> | null>(null)
    let doQuery: null | ((query: string) => (Promise<void> | null)) = null
    try {
        doQuery = useSqlResult({
            url,
            requestChunkSize,
            setResult,
        })
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
                            if (doQuery) {
                                const queries = query.split(";\n\n")
                                if (queries.length > 1) {
                                    console.log(`Running ${queries.length} queries`)
                                    queries.reduce<Promise<void> | null>(
                                        (prv, cur) => {
                                            if (!doQuery || !prv) return null
                                            return prv.then(() => {
                                                console.log("Running query:", cur)
                                                return doQuery && (doQuery(cur) ?? Promise.resolve())
                                            }) as Promise<void>
                                        },
                                        Promise.resolve()
                                    )
                                } else {
                                    console.log("Running query:", query)
                                    doQuery(query)
                                }
                            }
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
            <SqlResult result={result} />
        </div>
    )
}
