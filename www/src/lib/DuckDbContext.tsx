import { createContext, useContext, useEffect, useState, ReactNode } from "react"
import {
    AsyncDuckDB,
    AsyncDuckDBConnection,
    selectBundle,
    createWorker,
    PACKAGE_VERSION as DUCKDB_VERSION,
} from "@duckdb/duckdb-wasm"

const DuckDbContext = createContext<AsyncDuckDB | null>(null)

const SilentLogger = { log: () => {} }

/** Equivalent to `getJsDelivrBundles()` but served from unpkg. The jsdelivr
 *  CDN intermittently 404s the worker JS for headless Playwright Chromium
 *  (CI + local) — unpkg is more reliable for that fingerprint. */
function getUnpkgBundles() {
    const base = `https://unpkg.com/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/dist/`
    return {
        mvp: {
            mainModule: `${base}duckdb-mvp.wasm`,
            mainWorker: `${base}duckdb-browser-mvp.worker.js`,
        },
        eh: {
            mainModule: `${base}duckdb-eh.wasm`,
            mainWorker: `${base}duckdb-browser-eh.worker.js`,
        },
    }
}

async function initDuckDb(): Promise<AsyncDuckDB> {
    const allBundles = getUnpkgBundles()
    const bundle = await selectBundle(allBundles)
    if (!bundle.mainWorker) throw Error("No mainWorker in DuckDB bundle")
    const worker = await createWorker(bundle.mainWorker)
    const db = new AsyncDuckDB(SilentLogger, worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    await db.open({ path: ":memory:", query: { castBigIntToDouble: true } })
    return db
}

// Use window-level global so the singleton survives Vite HMR module re-execution
const GLOBAL_KEY = '__duckdb_shared_promise__'

function getSharedDb(): Promise<AsyncDuckDB> {
    const w = window as unknown as Record<string, unknown>
    if (!w[GLOBAL_KEY]) {
        w[GLOBAL_KEY] = initDuckDb()
    }
    return w[GLOBAL_KEY] as Promise<AsyncDuckDB>
}

export function DuckDbProvider({ children }: { children: ReactNode }) {
    const [db, setDb] = useState<AsyncDuckDB | null>(null)
    useEffect(() => {
        getSharedDb().then(setDb)
    }, [])
    return <DuckDbContext.Provider value={db}>{children}</DuckDbContext.Provider>
}

export function useDb(): AsyncDuckDB | null {
    return useContext(DuckDbContext)
}

/**
 * Run a query, properly closing the connection afterward.
 */
export async function runQuery<T = Record<string, unknown>>(db: AsyncDuckDB, query: string): Promise<T[]> {
    let conn: AsyncDuckDBConnection | null = null
    try {
        conn = await db.connect()
        const result = await conn.query(query)
        const proxies = result.toArray()
        return JSON.parse(JSON.stringify(proxies))
    } finally {
        if (conn) {
            await conn.close()
        }
    }
}

/**
 * Hook-style wrapper around runQuery.
 */
export function useQuery<T = Record<string, unknown>>({ db, query, init }: {
    db: AsyncDuckDB | null
    query: string | null
    init: T[]
}): T[] {
    const [data, setData] = useState(init)
    useEffect(() => {
        if (!db || !query) return
        runQuery<T>(db, query).then(setData).catch(err => {
            console.error(`useQuery error:`, err, `\nQuery: ${query}`)
        })
    }, [db, query])
    return data
}
