/** `readRows`: the rows of a parquet file matching a filter, reading only the row groups whose stats
 *  admit it and only the columns asked for (specs/off-duckdb-wasm.md § Design). */
import { parquetReadObjects, parquetSchema, type Compressors } from "hyparquet"
import { decompress as zstd } from "fzstd"
import { filterColumns, groupSkips, matchFilter, normalizeValue, type Filter } from "./filter"
import { sortRows, type SortKey } from "./ops"
import { openParquet, type ByteRange, type ParquetFile } from "./source"

export const compressors: Compressors = {
    ZSTD: (input: Uint8Array, outputLength: number) => zstd(input, new Uint8Array(outputLength)),
}

export type ReadOpts<T> = {
    /** Columns to return; ones the file doesn't have are just absent from rows (like DuckDB's
     *  `COLUMNS('^(a|b)$')`: road data and the site deploy separately). Default: all. */
    columns?: readonly string[]
    /** Every column it names must exist (else it throws, like SQL). */
    filter?: Filter
    /** Nulls last (DuckDB's default). May use columns outside `columns`. */
    orderBy?: readonly SortKey<T>[]
    limit?: number
}

/** A read's plan: which row groups, and the byte ranges of the column chunks it needs. */
export type ReadPlan = { groups: number[]; columns: string[]; ranges: ByteRange[] }

/** Top-level column names, in row-group chunk order. */
export function fileColumns(file: ParquetFile): string[] {
    return parquetSchema(file.metadata).children.map(c => c.element.name)
}

export function planRead(file: ParquetFile, opts: { columns?: readonly string[]; filter?: Filter; sortColumns?: readonly string[] }): ReadPlan {
    const all = fileColumns(file)
    const fcols = filterColumns(opts.filter)
    const missing = [...fcols].filter(c => !all.includes(c))
    if (missing.length) throw new Error(`${file.url}: filter column(s) not found: ${missing.join(", ")}`)
    const want = new Set([...(opts.columns ?? all), ...fcols, ...(opts.sortColumns ?? [])])
    const columns = all.filter(c => want.has(c))
    const chunkCols = file.metadata.row_groups[0]?.columns.map(c => c.meta_data?.path_in_schema[0] ?? "") ?? []
    const groups: number[] = []
    const ranges: ByteRange[] = []
    file.metadata.row_groups.forEach((g, i) => {
        if (Number(g.num_rows) === 0 || groupSkips(opts.filter, g, chunkCols)) return
        groups.push(i)
        for (const c of g.columns) {
            const md = c.meta_data
            if (!md || !columns.includes(md.path_in_schema[0])) continue
            const start = Number(md.dictionary_page_offset || md.data_page_offset)
            ranges.push({ start, end: start + Number(md.total_compressed_size) })
        }
    })
    return { groups, columns, ranges }
}

/** Columns named by string / `{ col }` sort keys (function keys must only read `columns`). */
function sortCols<T>(keys: readonly SortKey<T>[] | undefined): string[] {
    return (keys ?? []).flatMap(k => (typeof k === "string" ? [k] : typeof k === "object" ? [k.col] : []))
}

export async function readRows<T = Record<string, unknown>>(src: string | ParquetFile, opts: ReadOpts<T> = {}): Promise<T[]> {
    const file = typeof src === "string" ? await openParquet(src) : src
    const plan = planRead(file, { columns: opts.columns, filter: opts.filter, sortColumns: sortCols(opts.orderBy) })
    if (!plan.groups.length || !plan.columns.length) return []
    const buf = await file.prefetch(plan.ranges)
    const starts: number[] = []
    let acc = 0
    for (const g of file.metadata.row_groups) { starts.push(acc); acc += Number(g.num_rows) }
    const decoded = await Promise.all(plan.groups.map(i => parquetReadObjects({
        file: buf,
        metadata: file.metadata,
        columns: plan.columns,
        rowStart: starts[i],
        rowEnd: starts[i] + Number(file.metadata.row_groups[i].num_rows),
        compressors,
    })))
    const out = opts.columns ? new Set(opts.columns) : null
    let rows: Record<string, unknown>[] = []
    for (const group of decoded) {
        for (const raw of group) {
            for (const k in raw) raw[k] = normalizeValue(raw[k])
            if (opts.filter && !matchFilter(raw, opts.filter)) continue
            rows.push(raw)
        }
    }
    if (opts.orderBy?.length) rows = sortRows(rows as T[], opts.orderBy) as Record<string, unknown>[]
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit)
    if (out) for (const r of rows) for (const k in r) if (!out.has(k)) delete r[k]
    return rows as T[]
}

/** A file's key-value metadata (from the cached footer). */
export async function kvMetadata(url: string): Promise<Record<string, string>> {
    return (await openParquet(url)).kv
}
