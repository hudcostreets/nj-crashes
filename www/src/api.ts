/**
 * Crashes API client — fetches from CF Worker (D1) instead of sql.js-httpvfs.
 *
 * Returns fp-ts Either<Error, T[]> to match existing Result<T> interface.
 */
import { useEffect, useState } from "react"
import { Either, left, right } from "fp-ts/Either"

export type Result<T> = Either<Error, T[]>

const API_BASE = import.meta.env.VITE_API_URL ?? "/api"

export function apiUrl(path: string, params?: Record<string, string | number | null | undefined>): string {
    const url = new URL(`${API_BASE}${path}`, window.location.origin)
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== null && v !== undefined && v !== "") {
                url.searchParams.set(k, String(v))
            }
        }
    }
    return url.toString()
}

export function useApi<T>(url: string | null): Result<T> | null {
    const [result, setResult] = useState<Result<T> | null>(null)
    useEffect(() => {
        if (!url) {
            setResult(null)
            return
        }
        let cancelled = false
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
                return res.json()
            })
            .then((data: T[]) => {
                if (!cancelled) setResult(right(data))
            })
            .catch(err => {
                if (!cancelled) setResult(left(err instanceof Error ? err : new Error(String(err))))
            })
        return () => { cancelled = true }
    }, [url])
    return result
}

export function useApiEager<T>(url: string | null, init: T[]): Result<T> {
    const [result, setResult] = useState<Result<T>>(right(init))
    useEffect(() => {
        if (!url) return
        let cancelled = false
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
                return res.json()
            })
            .then((data: T[]) => {
                if (!cancelled) setResult(right(data))
            })
            .catch(err => {
                if (!cancelled) setResult(left(err instanceof Error ? err : new Error(String(err))))
            })
        return () => { cancelled = true }
    }, [url])
    return result
}
