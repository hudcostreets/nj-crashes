/** Test helpers (Node only): a `RangeFetch` over a local file, and DuckDB CLI rows for parity checks. */
import { execFileSync } from "node:child_process"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import type { RangeFetch } from "./source"

export function fileRangeFetch(path: string): RangeFetch {
    return async req => {
        const total = statSync(path).size
        const start = "suffix" in req ? Math.max(0, total - req.suffix) : req.start
        const end = "suffix" in req ? total : req.end
        const buf = Buffer.alloc(end - start)
        const fd = openSync(path, "r")
        try { readSync(fd, buf, 0, end - start, start) } finally { closeSync(fd) }
        return { buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, start, total }
    }
}

export const haveDuckdb = (() => {
    try { execFileSync("duckdb", ["-version"]); return true } catch { return false }
})()

export type Row = Record<string, unknown>

/** Floats rounded to float32: the CLI prints a FLOAT column's shortest float32 repr. */
export function normFloats(rows: Row[]): Row[] {
    return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Math.fround(v) : v])))
}

/** `duckdb -json` rows of `sql`; `fround`: normalize floats (`normFloats`, for FLOAT columns). */
export function duckRows(sql: string, { fround = true }: { fround?: boolean } = {}): Row[] {
    const out = execFileSync("duckdb", ["-json", "-c", sql], { maxBuffer: 1 << 30 }).toString().trim()
    const rows = out ? JSON.parse(out) as Row[] : []
    return fround ? normFloats(rows) : rows
}
