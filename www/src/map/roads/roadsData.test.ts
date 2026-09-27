import { describe, expect, it } from "vitest"
import {
    entityXsSql, nearestRoad, roadPaths, roadSegments, spanCrashesFilter, spanCrashesSql, spanFilter, spanPredicate, type RoadPoint,
} from "./roadsData"
import type { SpanSel } from "./roadScope"

// ~0.00147° lat ≈ 163 m: consecutive tenth-mile MP points on a north-south route.
const DLAT = 0.00147
const LON = -74.05
const lat0 = 40.75
const pt = (sri: string, mp: number, name: string, lon: number, lat: number, entity = 0): RoadPoint =>
    ({ sri, mp, sld_name: name, name, subt: 6, entity, alias: null, lon, lat })

const longRoad: RoadPoint[] = [0, 1, 2].map(i => pt("LONG", i / 10, "US 1", LON, lat0 + i * DLAT))
// A short side street whose only point sits 30 m east of the long road's midpoint between MP 0.0 and 0.1.
const side: RoadPoint = pt("SIDE", 0, "WALLER ST", LON + 30 / (111_320 * Math.cos(lat0 * Math.PI / 180)), lat0 + DLAT / 2, 1)

describe("nearestRoad", () => {
    it("picks the road whose segment passes under the cursor, not the nearest MP point", () => {
        // Cursor on the long road, halfway between its MP 0.0 and 0.1 points (~80 m from each).
        const cursor: [number, number] = [LON, lat0 + DLAT / 2]
        const segs = roadSegments([...longRoad, side])
        expect(nearestRoad(segs, cursor, 50)?.sri).toBe("LONG")
    })

    it("returns null beyond maxMeters", () => {
        const segs = roadSegments(longRoad)
        const cursor: [number, number] = [LON + 0.01, lat0]  // ~840 m east
        expect(nearestRoad(segs, cursor, 50)).toBe(null)
    })
})

describe("roadSegments / roadPaths", () => {
    it("joins consecutive MPs and breaks at MP gaps", () => {
        const gap: RoadPoint = pt("LONG", 0.9, "US 1", LON, lat0 + 3 * DLAT)
        const segs = roadSegments([...longRoad, gap, side])
        expect(segs.map(({ a, b }) => [a.sri, a.mp, b.mp])).toEqual([
            ["LONG", 0, 0.1],
            ["LONG", 0.1, 0.2],
            ["SIDE", 0, 0],  // single-point route → degenerate segment
        ])
        expect(roadPaths([...longRoad, gap]).map(p => p.length)).toEqual([3])
    })
})

/** `read_parquet('<url>/roads/<file>.parquet')` → `<file>`, whitespace collapsed. */
function norm(sql: string): string {
    return sql.replace(/read_parquet\('[^']*\/([^/']+)\.parquet'\)/g, "<$1>").replace(/\s+/g, " ").trim()
}

const blocks: SpanSel = { span: { lo: 1.46, hi: 1.532 }, hiClosed: false, blocks: [30, 31] }
const exact: SpanSel = { span: { lo: 1.46, hi: 1.5 }, hiClosed: false, blocks: null }
const toEnd: SpanSel = { span: { lo: 3, hi: 3.4835973 }, hiClosed: true, blocks: null }

describe("span SQL", () => {
    it("filters block-aligned spans by block id, exact spans by chain", () => {
        expect([spanPredicate(blocks), spanPredicate(exact), spanPredicate(toEnd)]).toEqual([
            "block BETWEEN 30 AND 31",
            "chain >= 1.4599 AND chain < 1.4999",
            "chain >= 2.9999 AND chain <= 3.4836973",
        ])
    })
    it("adds pinned rows, without corridor-only ones on v5.1", () => {
        expect([norm(spanCrashesSql(2800, blocks, true)), norm(spanCrashesSql(2800, exact, false))]).toEqual([
            "SELECT * FROM ( SELECT * FROM <crashes-by-entity> WHERE entity = 2800 AND block BETWEEN 30 AND 31 "
            + "UNION ALL SELECT * FROM <crashes-by-entity> WHERE entity = 2800 AND chain IS NULL AND chain_lo <= 1.532 AND chain_hi >= 1.46 "
            + "AND NOT coalesce(corridor_only, false) ) ORDER BY chain IS NULL, chain, dt",
            "SELECT * FROM ( SELECT * FROM <crashes-by-entity> WHERE entity = 2800 AND chain >= 1.4599 AND chain < 1.4999 "
            + "UNION ALL SELECT * FROM <crashes-by-entity> WHERE entity = 2800 AND chain IS NULL AND chain_lo <= 1.5 AND chain_hi >= 1.46 ) "
            + "ORDER BY chain IS NULL, chain, dt",
        ])
    })
    it("filters -xs rows the same way", () => {
        expect([norm(entityXsSql(2800, blocks)), norm(entityXsSql(2800))]).toEqual([
            "SELECT * FROM <crashes-by-entity-xs> WHERE entity = 2800 AND block BETWEEN 30 AND 31 ORDER BY chain, dt",
            "SELECT * FROM <crashes-by-entity-xs> WHERE entity = 2800 ORDER BY chain, dt",
        ])
    })
})

describe("span filters (the `readRows` twins of the span SQL)", () => {
    it("filters block-aligned spans by block id, exact spans by chain", () => {
        expect([spanFilter(blocks), spanFilter(exact), spanFilter(toEnd)]).toEqual([
            { block: { $gte: 30, $lte: 31 } },
            { chain: { $gte: 1.4599, $lt: 1.4999 } },
            { chain: { $gte: 2.9999, $lte: 3.4836973 } },
        ])
    })
    it("ORs in pinned rows, without corridor-only ones on v5.1", () => {
        expect([spanCrashesFilter(2800, blocks, true), spanCrashesFilter(2800, exact, false)]).toEqual([
            {
                entity: 2800,
                $or: [
                    { block: { $gte: 30, $lte: 31 } },
                    { chain: null, chain_lo: { $lte: 1.532 }, chain_hi: { $gte: 1.46 }, $or: [{ corridor_only: null }, { corridor_only: false }] },
                ],
            },
            {
                entity: 2800,
                $or: [
                    { chain: { $gte: 1.4599, $lt: 1.4999 } },
                    { chain: null, chain_lo: { $lte: 1.5 }, chain_hi: { $gte: 1.46 } },
                ],
            },
        ])
    })
})
