/** "Open in SQL" for a road scope: the query that lists its crashes. */
import { entityCrashesSql, entityXsSql, spanCrashesSql } from "./roadsData"
import type { SpanSel } from "./roadScope"

/** The road's (or span's) crashes; inclusive adds the `-xs` rows (`UNION ALL BY NAME`: they have
 *  an extra `own_entity`). Corridor scopes list the selected road's (per-member queries don't fit
 *  one statement). */
export function scopeSql(
    entity: number,
    v5: boolean,
    scope: { spanSel: SpanSel | null; v51: boolean; inclusive: boolean },
): string {
    const sel = scope.spanSel
    const own = sel ? spanCrashesSql(entity, sel, scope.v51) : entityCrashesSql(entity, v5)
    if (!v5 || !scope.inclusive) return own
    return `SELECT * FROM (${own}) UNION ALL BY NAME SELECT * FROM (${entityXsSql(entity, sel ?? undefined)})`
}
