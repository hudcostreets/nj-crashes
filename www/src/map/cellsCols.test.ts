import { describe, it, expect } from "vitest"
import { decodeTokens, heatCellsFromBody, type CellsColsBody, type CellsRowsBody } from "./cellsCols"
import { tokenCenterLngLat } from "./s2"

describe("decodeTokens", () => {
    it("decodes one-hex-digit shared-prefix lengths + suffixes", () => {
        expect(decodeTokens(["089c25c14", "7c", "62", "33"])).toEqual(["89c25c14", "89c25c1c", "89c25c2", "89c3"])
    })

    it("handles an empty suffix-extension and empty input", () => {
        expect(decodeTokens(["089c25c1", "74"])).toEqual(["89c25c1", "89c25c14"])
        expect(decodeTokens([])).toEqual([])
    })
})

describe("heatCellsFromBody", () => {
    // Journal Square l15 cells (real tokens, from the cells-api pyramid test),
    // plus an all-zero cell that must be dropped.
    const cols: CellsColsBody = {
        format: "cols", cellid_enc: "prefix-hex1", n: 3,
        cols: {
            cellid: ["089c2572dc", "7e4", "6304"],
            n_fatal: [0, 0, 1],
            n_inj_ped: [28, 0, 20],
            n_inj_other: [45, 0, 45],
            n_pdo: [382, 0, 272],
        },
    }
    const rows: CellsRowsBody = {
        cells: [
            { cellid: "89c2572dc", n_fatal: 0, n_inj_ped: 28, n_inj_other: 45, n_pdo: 382 },
            { cellid: "89c2572e4", n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0 },
            { cellid: "89c257304", n_fatal: 1, n_inj_ped: 20, n_inj_other: 45, n_pdo: 272 },
        ],
    }
    const expected = [
        { cellid: "89c2572dc", center: tokenCenterLngLat("89c2572dc"), fatal: 0, pedInj: 28, otherInj: 45, pdo: 382, total: 455 },
        { cellid: "89c257304", center: tokenCenterLngLat("89c257304"), fatal: 1, pedInj: 20, otherInj: 45, pdo: 272, total: 338 },
    ]

    it("decodes the cols shape into StackedCells, dropping zero-total cells", () => {
        expect(heatCellsFromBody(cols)).toEqual(expected)
    })

    it("decodes the legacy rows shape identically (worker/client deploy skew)", () => {
        expect(heatCellsFromBody(rows)).toEqual(expected)
    })

    it("sanity: the centers are real NJ coordinates", () => {
        const [lng, lat] = expected[0].center
        expect([lng.toFixed(2), lat.toFixed(2)]).toEqual(["-74.07", "40.73"])
    })

    it("rejects a missing / short count column and an unknown token encoding", () => {
        const { n_pdo: _, ...noPdo } = cols.cols
        expect(() => heatCellsFromBody({ ...cols, cols: { ...noPdo, cellid: cols.cols.cellid } }))
            .toThrow("cells cols: 'n_pdo' missing or length ≠ 3")
        expect(() => heatCellsFromBody({ ...cols, cols: { ...cols.cols, n_fatal: [0] } }))
            .toThrow("cells cols: 'n_fatal' missing or length ≠ 3")
        expect(() => heatCellsFromBody({ ...cols, cellid_enc: "raw" as "prefix-hex1" }))
            .toThrow("unknown cellid_enc 'raw'")
    })
})
