import type { RoadRank } from "./roadsData"

export type RankMetric = "crashes" | "fatal" | "killed" | "per_mi"

/** `rows` ranked by `metric` (the area's top 50 for it; rows outside it dropped). */
export function rankedBy(rows: RoadRank[], metric: RankMetric): RoadRank[] {
    const rank = (r: RoadRank) => r[`rank_${metric}`]
    return rows.filter(r => rank(r) !== null).sort((a, b) => rank(a)! - rank(b)!)
}
