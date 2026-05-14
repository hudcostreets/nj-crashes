/** Lazy-load the per-hex nearest-MP-name sidecar
 *  (`{MAP_BASE_URL}/v2/hex-sld.parquet`, ~1.7 MB) and expose it as a
 *  Map<h3, SldEntry> for synchronous tooltip lookups.
 *
 *  Built by `njdot/cli/export_hex_sld.py`. Covers all unique H3 cells
 *  across r6-r9 (~103k); one row per cell. Cells outside the sidecar
 *  (e.g. resolutions we don't pre-compute) just fall back to the
 *  existing `top_route` summary baked into the hex parquet. */
import { useEffect, useState } from "react"
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet"
import { MAP_BASE_URL } from "./config"

export type SldEntry = {
    sld_name: string
    sri: string
    mp: number
    route_subt: number
}

export type HexSldMap = ReadonlyMap<string, SldEntry>

let cached: Promise<HexSldMap> | null = null

async function loadHexSld(): Promise<HexSldMap> {
    const url = `${MAP_BASE_URL}/v2/hex-sld.parquet`
    const file = await asyncBufferFromUrl({ url })
    const rows = (await parquetReadObjects({ file })) as Array<{
        h3: string; sld_name: string; sri: string; mp: number; route_subt: number
    }>
    const m = new Map<string, SldEntry>()
    for (const r of rows) {
        m.set(r.h3, { sld_name: r.sld_name, sri: r.sri, mp: r.mp, route_subt: r.route_subt })
    }
    return m
}

export function useHexSld(): HexSldMap | null {
    const [data, setData] = useState<HexSldMap | null>(null)
    useEffect(() => {
        if (!cached) cached = loadHexSld()
        let cancelled = false
        cached.then(m => { if (!cancelled) setData(m) })
        return () => { cancelled = true }
    }, [])
    return data
}
