/** S2 cell geometry constants, with no runtime dependencies.
 *
 *  Split out of `s2/index.ts` (which pulls in `nodes2ts`) so
 *  `StackedHexLayer` can share the table instead of keeping its own copy.
 *  The copies had already drifted — the layer's table started at level 4
 *  while `s2/index.ts`'s ran from 0, and the layer's `?? 478` fallback
 *  silently sized any out-of-table level as level 14.
 */

/** Edge length of an average S2 cell, in meters, at each level.
 *  Sourced from Google's published stats table (min/avg/max per level):
 *  https://s2geometry.io/resources/s2cell_statistics.html — the AVG column.
 *
 *  **Edge, not diameter.** This was called `S2_DIAMETER_METERS` until the
 *  h3-removal naming pass: the H3 picker keyed off a vertex *diameter*
 *  (`2 × H3_RADIUS_METERS[r]`), and the S2 port kept the name while
 *  switching the quantity. Every consumer already treats these as edges
 *  (inscribed radius = `edge / 2`, on-screen width = `edge / mppx`), so the
 *  name was the only thing that was wrong — but it's the kind of wrong that
 *  makes the next `area = π(d/2)²` a silent factor-of-2 error.
 *
 *  Edge is the natural on-screen width: a level-N cell occupies roughly
 *  `edge/mppx` pixels. Cells vary ~15% within a level (avg vs actual by
 *  latitude), so the picker's boundary zooms straddle levels a bit. */
export const S2_EDGE_METERS: Record<number, number> = {
    0: 7_842_000,     // 6 faces of the cube — toy scale
    1: 3_921_000,
    2: 1_961_000,
    3: 980_000,
    4: 490_000,       // ~NJ half
    5: 245_000,
    6: 122_500,       // ~county
    7: 61_250,
    8: 30_625,        // ~large town
    9: 15_312,
    10: 7_656,        // ~urban district
    11: 3_828,        // ~city grid super-block
    12: 1_914,        // ~city block
    13: 957,          // ~half-block
    14: 478,          // ~intersection cluster
    15: 239,
    16: 120,          // ~single street segment
    17: 60,           // ~sidewalk-scale
    18: 30,           // ~single parked car
    19: 15,           // ~half an intersection / crosswalk-scale
    20: 7.5,          // ~crosswalk width
    21: 3.75,         // finest level the pyramid builds
}

/** Level range the pyramid supports, and the range every picker and
 *  renderer clamps to. Levels 0-3 exist in `S2_EDGE_METERS` (the table is
 *  the published stats table, unabridged) but are continent-scale and have
 *  no pyramid behind them. */
export const S2_MIN_LEVEL = 4
export const S2_MAX_LEVEL = 21

/** Clamp a level into the supported range. */
export function clampS2Level(level: number): number {
    return Math.max(S2_MIN_LEVEL, Math.min(S2_MAX_LEVEL, level))
}

/** Edge length as the *picker* sees it: the table value scaled by this
 *  level's `pickMult` (see `tuning.json`).
 *
 *  Exported because anything that inverts the picker — snap-to-level
 *  buttons, the zoom/level chart's transition lines — has to apply the same
 *  multiplier the picker does, or it computes a px target the picker then
 *  evaluates against a different number and lands a level or two away. */
export function s2PickEdgeMeters(level: number, pickMult: Record<number, number>): number {
    return (S2_EDGE_METERS[level] ?? 0) * (pickMult[level] ?? 1)
}
