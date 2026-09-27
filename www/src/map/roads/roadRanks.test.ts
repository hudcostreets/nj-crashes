import { describe, expect, it } from "vitest"
import { rankedBy } from "./roadRanks"
import type { RoadRank } from "./roadsData"

const rank = (entity: number, r: Partial<RoadRank>): RoadRank => ({
    cc: 9, mc: 6, entity, slug: `hudson/jersey-city/r${entity}`, name: `R${entity}`, route: null, subt: 7,
    n_crashes: 0, n_fatal: 0, n_killed: 0, length_mi: 1, per_mi: null,
    rank_crashes: null, rank_fatal: null, rank_killed: null, rank_per_mi: null, ...r,
})

describe("rankedBy", () => {
    const rows = [
        rank(1, { rank_crashes: 2, rank_fatal: 1 }),
        rank(2, { rank_crashes: 1, rank_per_mi: 2 }),
        rank(3, { rank_crashes: 3, rank_fatal: 2, rank_per_mi: 1 }),
    ]
    it("orders by the metric's rank, dropping roads outside its top N", () => {
        expect(rankedBy(rows, "crashes").map(r => r.entity)).toEqual([2, 1, 3])
        expect(rankedBy(rows, "fatal").map(r => r.entity)).toEqual([1, 3])
        expect(rankedBy(rows, "per_mi").map(r => r.entity)).toEqual([3, 2])
        expect(rankedBy(rows, "killed").map(r => r.entity)).toEqual([])
    })
})
