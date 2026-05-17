/** Lazy-load the per-hex nearest-MP-name sidecar
 *  (`{MAP_BASE_URL}/v2/hex-sld.parquet`, ~1.7 MB) and expose it as a
 *  lookup helper for tooltip street names + muni/county labels.
 *
 *  Built by `njdot/cli/export_hex_sld.py`. The sidecar enumerates
 *  unique H3 cells at r6-r9 (~103k rows); for cells at finer
 *  resolutions the `lookup()` helper walks up the parent chain until
 *  it finds a match. Walking up to r9 means an r14 (1.4m) cell
 *  inherits the road of its containing r9 (174m) cell — fine in
 *  practice since a single r9 footprint rarely spans two named
 *  roads. */
import { useEffect, useState } from "react"
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet"
import { cellToParent, getResolution } from "h3-js"
import { MAP_BASE_URL } from "./config"

export type SldEntry = {
    sld_name: string
    sri: string
    mp: number
    route_subt: number
    /** Nearest road on a different SRI within ~80m of the cell centroid.
     *  Empty when no qualifying neighbor exists (mid-block cells). Used
     *  in the tooltip as a cross-street hint. */
    cross_sld_name: string
    cross_sri: string
    cross_mp: number
    mun: string
    county: string
}

/** Lookup helper. `get(h3)` first tries the exact cell, then climbs
 *  parents down to `minRes` (cells coarser than the sidecar's coverage
 *  are returned as-is — typically r6 is the floor). */
export type HexSldLookup = {
    get(h3: string): SldEntry | undefined
}

/** Coarsest H3 res covered by the sidecar. The walk-up loop stops at
 *  this resolution — anything coarser than r6 is statewide-ish and
 *  shouldn't pretend to be a specific road. */
const SLD_MIN_RES = 6

let cached: Promise<HexSldLookup> | null = null

async function loadHexSld(): Promise<HexSldLookup> {
    const url = `${MAP_BASE_URL}/v2/hex-sld.parquet`
    const file = await asyncBufferFromUrl({ url })
    const rows = (await parquetReadObjects({ file })) as Array<{
        h3: string; sld_name: string; sri: string; mp: number; route_subt: number;
        cross_sld_name: string | null; cross_sri: string | null; cross_mp: number | null;
        mun: string; county: string
    }>
    const m = new Map<string, SldEntry>()
    for (const r of rows) {
        m.set(r.h3, {
            sld_name: r.sld_name,
            sri: r.sri,
            mp: r.mp,
            route_subt: r.route_subt,
            cross_sld_name: r.cross_sld_name ?? "",
            cross_sri: r.cross_sri ?? "",
            cross_mp: r.cross_mp ?? NaN,
            mun: r.mun ?? "",
            county: r.county ?? "",
        })
    }
    return {
        get(h3: string): SldEntry | undefined {
            const direct = m.get(h3)
            if (direct) return direct
            let res = getResolution(h3)
            let cur = h3
            while (res > SLD_MIN_RES) {
                res--
                cur = cellToParent(cur, res)
                const hit = m.get(cur)
                if (hit) return hit
            }
            return undefined
        },
    }
}

export function useHexSld(): HexSldLookup | null {
    const [data, setData] = useState<HexSldLookup | null>(null)
    useEffect(() => {
        if (!cached) {
            cached = loadHexSld()
            cached.catch(() => { cached = null })  // allow retry on next mount after a 404/network blip
        }
        let cancelled = false
        cached.then(m => { if (!cancelled) setData(m) }).catch(() => {})
        return () => { cancelled = true }
    }, [])
    return data
}
