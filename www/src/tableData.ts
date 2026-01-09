import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { useEffect, useState } from "react";
import { basename } from "@/src/lib/path";
import { runQuery } from "@rdub/duckdb/duckdb";

export type CsvData = {
    kind: 'csv'
    data: string
}
export type PqtData = {
    kind: 'pqt'
    base64: string
}
export type Url = {
    // kind: 'url'
    url: string
}
export type TableData = CsvData | PqtData // | Url

export type HasDb = {
    db: AsyncDuckDB
}
export type MaybeDb = {
    db: AsyncDuckDB | null
}
export type HasCsvText = {
    csvText: string
}
export type MaybeTable = {
    table?: string
}
export type HasTable = {
    table: string
}
export type DbProps = HasDb & HasTable & HasCsvText
export type HasQuery = {
    query: string
}
export type UseProps<T> = Url & MaybeDb & MaybeTable & HasQuery & {
    init: T[]
}

export function useCsvText({ url, }: { url: string }): string | null {
    const [ csvText, setCsvText ] = useState<string | null>(null)
    useEffect(() => {
        fetch(url).then(r => r.text()).then(setCsvText)
    }, [ url, ]);
    return csvText
}

export async function getRegisteredDb({ db, table, csvText, }: DbProps): Promise<AsyncDuckDB> {
    await db.registerFileText(table, csvText)
    return db
}

export function useRegisteredDb({ db, table, url }: MaybeDb & HasTable & Url): AsyncDuckDB | null {
    const [ registeredDb, setRegisteredDb ] = useState<AsyncDuckDB | null>(null)
    const csvText = useCsvText({ url })
    useEffect(() => {
        async function register() {
            if (!db || !csvText) return
            console.log(`registering db table ${table}: ${url}`)
            setRegisteredDb(await getRegisteredDb({ db, table, csvText, }))
        }
        register()
    }, [ db, csvText, ]);
    return registeredDb
}

export async function registerTableData({ db, tableData, stem }: {
    db: AsyncDuckDB
    tableData: TableData
    stem: string
}): Promise<string> {
    let target: string
    if (tableData.kind === 'csv') {
        const path = `${stem}.csv`
        target = `'${path}'`
        await db.registerFileText(path, tableData.data)
    } else {
        const path = `${stem}.parquet`
        target = `parquet_scan('${path}')`
        const binaryString = atob(tableData.base64)
        const ytcPqtArr = Uint8Array.from(binaryString, c => c.charCodeAt(0))
        await db.registerFileBuffer(path, ytcPqtArr)
    }
    return target
}

export function useTable({ db, tableData, stem }: { db: AsyncDuckDB | null, tableData: TableData, stem: string }): string | null {
    const [ target, setTarget ] = useState<string | null>(null)
    useEffect(
        () => {
            async function init() {
                if (!db) return
                console.log("got db:", db)
                const target = await registerTableData({ db, tableData, stem, })
                console.log("registered target:", target)
                setTarget(target)
            }
            init()
        },
        [ db, tableData, ]
    )
    return target
}

export function useCsvTable<T>({ url, db, table, query, init, }: UseProps<T>): T[] {
    const registeredDb = useRegisteredDb({ db, table: table ?? basename(url), url })
    const [ data, setData ] = useState(init)
    useEffect(() => {
        async function get() {
            console.log(`querying table ${table}`)
            if (!registeredDb) return
            const res = await runQuery<T>(registeredDb, query)
            setData(res)
        }
        get()
    }, [ registeredDb, query, ]);
    return data
}

// Hook for loading and querying SQLite databases via URL
export function useSqliteDb({ db, url, table }: MaybeDb & Url & HasTable): string | null {
    const [target, setTarget] = useState<string | null>(null)
    useEffect(() => {
        async function register() {
            if (!db) return
            try {
                // Fetch the SQLite file
                const response = await fetch(url)
                const buffer = await response.arrayBuffer()
                const fileName = `${table}.db`

                // Register the file with DuckDB
                await db.registerFileBuffer(fileName, new Uint8Array(buffer))

                // Install and load SQLite scanner extension
                await runQuery(db, "INSTALL sqlite_scanner")
                await runQuery(db, "LOAD sqlite_scanner")

                // Attach the SQLite database
                await runQuery(db, `ATTACH '${fileName}' AS ${table}_db (TYPE sqlite)`)

                // Return the table reference
                setTarget(`${table}_db.${table}`)
                console.log(`Registered SQLite table: ${table}_db.${table}`)
            } catch (e) {
                console.error(`Failed to load SQLite database ${url}:`, e)
            }
        }
        register()
    }, [db, url, table])
    return target
}
