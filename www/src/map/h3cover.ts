/** Pure H3 cover-math helpers — no React / maplibre / deck imports, so
 *  they're cheap to unit-test in isolation. */
import { cellToParent, getResolution } from "h3-js"

/** Is `h3` inside the NJ root cover? `rootCells` is the manifest's
 *  top-level `shard_cells` — the cells at `rootRes` (r4) that cover NJ.
 *
 *  - `res >= rootRes`: in NJ iff `h3`'s `rootRes` ancestor is a root cell.
 *  - `res < rootRes`: `h3` is *coarser* than the root cover (e.g. the
 *    r2/r3 cells a statewide cover starts from) — in NJ iff some root
 *    cell descends from it. An earlier `res <= rootRes ? h3 : …` form
 *    silently rejected every coarse cell (an r2/r3 cell is never in the
 *    r4 set), which emptied statewide covers entirely. */
export function isInRootCover(h3: string, rootCells: Set<string>, rootRes: number): boolean {
    const res = getResolution(h3)
    if (res >= rootRes) return rootCells.has(cellToParent(h3, rootRes))
    for (const rc of rootCells) {
        if (cellToParent(rc, res) === h3) return true
    }
    return false
}
