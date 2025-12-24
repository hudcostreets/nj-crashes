import { useEffect, useState } from "react"
import { parquetRead } from "hyparquet"

export type ParquetTiming = {
    fetchMs: number
    parseMs: number
    totalMs: number
    bytes: number
}

export type ParquetResult<T> = {
    data: T[] | null
    loading: boolean
    error: string | null
    timing: ParquetTiming | null
}

/**
 * Hook to load a local parquet file and parse it with hyparquet.
 *
 * @param url - URL to the parquet file (e.g., "/data/njdot/ys.parquet")
 * @param columns - Optional list of columns to read (reads all if not specified)
 */
export function useParquet<T extends Record<string, unknown>>(
    url: string,
    columns?: string[],
): ParquetResult<T> {
    const [data, setData] = useState<T[] | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [timing, setTiming] = useState<ParquetTiming | null>(null)

    useEffect(() => {
        let cancelled = false
        const startTime = performance.now()

        async function load() {
            try {
                // Fetch the parquet file
                const fetchStart = performance.now()
                const response = await fetch(url)
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${url}: ${response.status}`)
                }
                const buffer = await response.arrayBuffer()
                const fetchEnd = performance.now()

                if (cancelled) return

                // Parse with hyparquet
                const parseStart = performance.now()
                const rows: T[] = []

                await parquetRead({
                    file: buffer,
                    columns,
                    rowFormat: 'object',  // Return rows as {col: value} objects
                    onComplete: (data: unknown) => {
                        if (Array.isArray(data)) {
                            rows.push(...(data as T[]))
                        }
                    },
                })

                const parseEnd = performance.now()
                const endTime = performance.now()

                if (cancelled) return

                setData(rows)
                setTiming({
                    fetchMs: fetchEnd - fetchStart,
                    parseMs: parseEnd - parseStart,
                    totalMs: endTime - startTime,
                    bytes: buffer.byteLength,
                })
                setLoading(false)

                console.log(
                    `📊 [${url}] ${(endTime - startTime).toFixed(0)}ms total ` +
                    `(${(fetchEnd - fetchStart).toFixed(0)}ms fetch, ` +
                    `${(parseEnd - parseStart).toFixed(0)}ms parse) ` +
                    `${(buffer.byteLength / 1024).toFixed(1)} KB, ${rows.length} rows`
                )
            } catch (err) {
                if (cancelled) return
                const message = err instanceof Error ? err.message : "Unknown error"
                console.error(`❌ [${url}] Error:`, message)
                setError(message)
                setLoading(false)
            }
        }

        load()

        return () => {
            cancelled = true
        }
    }, [url, columns?.join(",")])

    return { data, loading, error, timing }
}
