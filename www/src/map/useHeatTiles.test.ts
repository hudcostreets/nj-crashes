import { describe, expect, it } from "vitest"
import { fetchTiles, parentTile, stickyVmax, tileUrl } from "./useHeatTiles"
import { CELLS_API_BASE } from "./config"

describe("useHeatTiles helpers", () => {
    it("parentTile: one zoom up", () => {
        expect([parentTile({ z: 15, x: 9649, y: 12317 }), parentTile({ z: 15, x: 9648, y: 12316 })])
            .toEqual([{ z: 14, x: 4824, y: 6158 }, { z: 14, x: 4824, y: 6158 }])
    })

    it("fetchTiles: distinct parents, first-seen order", () => {
        const tiles = [
            { z: 15, x: 9647, y: 12316 }, { z: 15, x: 9648, y: 12316 }, { z: 15, x: 9649, y: 12316 },
            { z: 15, x: 9647, y: 12317 }, { z: 15, x: 9648, y: 12317 }, { z: 15, x: 9649, y: 12317 },
        ]
        expect(fetchTiles(tiles)).toEqual([{ z: 14, x: 4823, y: 6158 }, { z: 14, x: 4824, y: 6158 }])
    })

    it("stickyVmax: keeps the previous value within ±25%", () => {
        expect([
            stickyVmax(null, 10),
            stickyVmax(10, 12),
            stickyVmax(10, 8.1),
            stickyVmax(10, 12.6),
            stickyVmax(10, 7.9),
            stickyVmax(0, 5),
        ]).toEqual([10, 10, 10, 12.6, 7.9, 5])
    })

    it("tileUrl: padded parent bbox, lean params; per-year table for a year sub-range", () => {
        const f = { yearRange: [2011, 2013] as [number, number], severities: new Set(["f", "i", "p"] as const) }
        const q = (url: string | null) => url && Object.fromEntries(new URL(url).searchParams)
        const tile = { z: 14, x: 4823, y: 6158 }
        const byYear = tileUrl(tile, 20, f, true, [2001, 2025])
        expect(byYear?.startsWith(`${CELLS_API_BASE}/v1/cells?`)).toBe(true)
        expect(q(byYear)).toEqual({
            cells: "89b,89d",
            res: "20",
            maxCells: "150000",
            polygon: "-74.0292,40.7498,-74.0006,40.7498,-74.0006,40.7281,-74.0292,40.7281,-74.0292,40.7498",
            labels: "nums",
            format: "cols",
            fields: "n_fatal,n_inj_ped,n_inj_other,n_pdo",
            years: "2001-2025",
            severities: "fip",
            group: "year",
        })
        // No `group_year` capability: the filter goes to the worker.
        expect(q(tileUrl(tile, 20, f, false, [2001, 2025]))).toEqual({
            cells: "89b,89d",
            res: "20",
            maxCells: "150000",
            polygon: "-74.0292,40.7498,-74.0006,40.7498,-74.0006,40.7281,-74.0292,40.7281,-74.0292,40.7498",
            labels: "nums",
            format: "cols",
            fields: "n_fatal,n_inj_ped,n_inj_other,n_pdo",
            years: "2011-2013",
            severities: "fip",
        })
    })

    it("tileUrl: a scope polygon that misses the tile → no request", () => {
        const f = {
            yearRange: [2001, 2025] as [number, number],
            severities: new Set(["f", "i", "p"] as const),
            clipPolygon: [[-75, 40], [-74.9, 40], [-74.9, 40.1], [-75, 40.1], [-75, 40]] as [number, number][],
        }
        expect(tileUrl({ z: 14, x: 4823, y: 6158 }, 20, f, true, [2001, 2025])).toBe(null)
    })
})
