/** Viewport clipping of fetched cells that keeps the clipped array's identity across pan frames.
 *
 *  deck.gl treats a new `data` array as a data change: every attribute is recomputed, and the
 *  legacy `HeatmapLayer` re-splats its weights texture and re-runs its max-reduction pass (a
 *  GPU pass over every texel). Re-clipping per rendered frame made each pan / hover frame pay
 *  that (specs/map-mobile-perf.md § Round 2). Instead, clip to a padded *window* around the
 *  viewport and reuse the result until the viewport leaves the window (or the data changes). */
import type { Bbox } from "./v2"

/** `bbox` grown by `frac` of its width / height on every side. */
export function padBbox([w, s, e, n]: Bbox, frac: number): Bbox {
    const dx = (e - w) * frac, dy = (n - s) * frac
    return [w - dx, s - dy, e + dx, n + dy]
}

/** Whether `outer` contains `inner`. */
export function bboxContains([w, s, e, n]: Bbox, [w2, s2, e2, n2]: Bbox): boolean {
    return w <= w2 && s <= s2 && e >= e2 && n >= n2
}

export type Clipped<T> = { data: readonly T[]; window: Bbox | null; cells: T[] }

/** Pad applied around the viewport for the clip window: a pan of up to half a viewport reuses it. */
export const CLIP_WINDOW_PAD = 0.5

/** The clip of `data` to `viewport`, reusing `prev` when it was cut from the same `data` and its
 *  window still contains the viewport. No viewport → `data` unclipped. */
export function stableClip<T extends { center: [number, number] }>(
    prev: Clipped<T> | null,
    data: readonly T[],
    viewport: Bbox | null | undefined,
    pad = CLIP_WINDOW_PAD,
): Clipped<T> {
    if (!viewport) {
        if (prev && prev.data === data && prev.window === null) return prev
        return { data, window: null, cells: data as T[] }
    }
    if (prev && prev.data === data && prev.window && bboxContains(prev.window, viewport)) return prev
    const window = padBbox(viewport, pad)
    const [w, s, e, n] = window
    const cells = data.filter(({ center: [x, y] }) => x >= w && x <= e && y >= s && y <= n)
    return { data, window, cells }
}
