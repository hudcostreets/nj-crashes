import { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm"
import { useQuery } from "@tanstack/react-query"

export type CsvData = {
    kind: 'csv'
    data: string
}
export type PqtData = {
    kind: 'pqt'
    base64: string
}
export type TableData = CsvData | PqtData

export type HasQuery = {
    query: string
}
export type UseProps<T> = HasQuery & {
    conn: AsyncDuckDBConnection | null
    init: T[]
}

export function useCsvTable<T>({ conn, query, init, }: UseProps<T>): T[] {
    const { data } = useQuery({
        queryKey: [ 'csv', conn === null ],
        refetchOnWindowFocus: false,
        refetchInterval: false,
        initialData: init,
        queryFn: async () => {
            if (!conn) return null
            console.log("running query:", conn)
            return JSON.parse(JSON.stringify((await conn.query(query)).toArray()))
        }
    })
    return data
}
