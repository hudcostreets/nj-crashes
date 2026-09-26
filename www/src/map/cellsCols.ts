/** Decoder for `/v1/cells?format=cols` (see `cells-api/src/cells.ts`
 *  `CellsColsResponse` and `specs/cells-compact-wire-format.md`): sorted
 *  parallel arrays of just the requested count columns, with prefix-delta
 *  encoded S2 tokens. Heatmap C (`useHeatTiles`) is the first consumer. */
import { tokenCenterLngLat } from "./s2"
import type { StackedCell } from "./StackedCellLayer"

/** The count columns heatmap C needs: exactly what `StackedCell` carries
 *  (and so what `cellHeatWeight` can read). */
export const HEAT_FIELDS = ["n_fatal", "n_inj_ped", "n_inj_other", "n_pdo"] as const
type HeatField = typeof HEAT_FIELDS[number]

type Counts = Record<HeatField, number>

export type CellsColsBody = {
    format: "cols"
    cellid_enc: "prefix-hex1"
    n: number
    cols: { cellid: string[] } & Partial<Record<HeatField, number[]>>
}

export type CellsRowsBody = {
    format?: undefined
    cells: Array<{ cellid: string } & Counts>
}

/** Inverse of the worker's `encodeTokens`: each entry is a one-hex-digit
 *  shared-prefix length (vs. the previous token) followed by the suffix. */
export function decodeTokens(enc: string[]): string[] {
    const out: string[] = new Array(enc.length)
    let prev = ""
    for (let i = 0; i < enc.length; i++) {
        const e = enc[i]
        prev = prev.slice(0, parseInt(e[0], 16)) + e.slice(1)
        out[i] = prev
    }
    return out
}

function stackedCell(cellid: string, fatal: number, pedInj: number, otherInj: number, pdo: number): StackedCell | null {
    const total = fatal + pedInj + otherInj + pdo
    if (total === 0) return null
    return { cellid, center: tokenCenterLngLat(cellid), fatal, pedInj, otherInj, pdo, total }
}

/** A `/v1/cells` body → heatmap C's `StackedCell[]`. Accepts the `cols`
 *  shape and the legacy row shape: a worker that predates `format=cols`
 *  ignores the param and answers in rows, so the client works against
 *  either during a worker/client deploy skew. Zero-total cells are dropped
 *  either way. */
export function heatCellsFromBody(body: CellsColsBody | CellsRowsBody): StackedCell[] {
    const out: StackedCell[] = []
    if (body.format === "cols") {
        if (body.cellid_enc !== "prefix-hex1") throw new Error(`unknown cellid_enc '${body.cellid_enc}'`)
        const { cols } = body
        const ids = decodeTokens(cols.cellid)
        const col = (f: HeatField): number[] => {
            const c = cols[f]
            if (!c || c.length !== ids.length) throw new Error(`cells cols: '${f}' missing or length ≠ ${ids.length}`)
            return c
        }
        const fatal = col("n_fatal"), pedInj = col("n_inj_ped"), otherInj = col("n_inj_other"), pdo = col("n_pdo")
        for (let i = 0; i < ids.length; i++) {
            const c = stackedCell(ids[i], fatal[i], pedInj[i], otherInj[i], pdo[i])
            if (c) out.push(c)
        }
        return out
    }
    for (const r of body.cells) {
        const c = stackedCell(r.cellid, r.n_fatal, r.n_inj_ped, r.n_inj_other, r.n_pdo)
        if (c) out.push(c)
    }
    return out
}
