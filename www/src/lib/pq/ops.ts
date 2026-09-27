/** JS-side helpers for query results: ordering (DuckDB's default: nulls last) and group-by sums. */

export type SortValue = number | string | boolean | null | undefined
/** A column (ascending), `{ col, desc }`, or a key function. */
export type SortKey<T> = (keyof T & string) | { col: keyof T & string; desc?: boolean } | ((row: T) => SortValue)

function cmp(a: SortValue, b: SortValue): number {
    const an = a === null || a === undefined, bn = b === null || b === undefined
    if (an || bn) return an === bn ? 0 : an ? 1 : -1
    return a! < b! ? -1 : a! > b! ? 1 : 0
}

/** Sorted copy of `rows` by `keys` (stable; nulls last, also when descending). */
export function sortRows<T>(rows: readonly T[], keys: readonly SortKey<T>[]): T[] {
    const fns = keys.map(k => {
        if (typeof k === "function") return { get: k, desc: false }
        if (typeof k === "string") return { get: (r: T) => r[k] as SortValue, desc: false }
        return { get: (r: T) => r[k.col] as SortValue, desc: !!k.desc }
    })
    return [...rows].sort((a, b) => {
        for (const { get, desc } of fns) {
            const x = get(a), y = get(b)
            const nx = x === null || x === undefined, ny = y === null || y === undefined
            const c = nx || ny ? cmp(x, y) : desc ? -cmp(x, y) : cmp(x, y)
            if (c) return c
        }
        return 0
    })
}

/** `SELECT <keys>, sum(…) … GROUP BY <keys> ORDER BY <keys>`: one row per distinct key tuple, each
 *  of `sums` totalled over its rows (null counts as 0; a group of all nulls sums to 0). */
export function groupSum<T extends Record<string, unknown>, K extends keyof T & string, S extends string>(
    rows: readonly T[],
    keys: readonly K[],
    sums: Record<S, (row: T) => number | null | undefined>,
): (Pick<T, K> & Record<S, number>)[] {
    const groups = new Map<string, Pick<T, K> & Record<S, number>>()
    const names = Object.keys(sums) as S[]
    for (const r of rows) {
        const id = JSON.stringify(keys.map(k => r[k]))
        let g = groups.get(id)
        if (!g) {
            g = {} as Pick<T, K> & Record<S, number>
            for (const k of keys) (g as Record<string, unknown>)[k] = r[k]
            for (const s of names) (g as Record<string, number>)[s] = 0
            groups.set(id, g)
        }
        for (const s of names) (g as Record<string, number>)[s] += sums[s](r) ?? 0
    }
    return sortRows([...groups.values()], keys as unknown as SortKey<Pick<T, K> & Record<S, number>>[])
}
