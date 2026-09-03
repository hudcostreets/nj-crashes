/** Viewport-area budgeting for the cell-bin picker.
 *
 *  The picker sizes cells so ~`budget` of them fill the map (see
 *  `picker.ts`). "The map" should mean the *data-bearing* area, not the
 *  raw viewport: for a scoped view (county/muni, or statewide) the fetch
 *  is clipped to a polygon, so empty margin outside it — ocean, PA, the
 *  letterbox around a tall/narrow scope in a wide viewport — must not
 *  spend bin budget. `clippedAreaPx` reduces the raw viewport area to
 *  `area(scope ∩ viewport)` in px² whenever a clip ring is supplied.
 *
 *  Kept as a pure module (no React/viewState) so the fit→clip→pick
 *  pipeline can be pinned across a viewport sweep in `areaBudget.test.ts`
 *  — notably that statewide's pick is width-independent (the bug this was
 *  extracted to guard). */
import { bboxFromViewport } from "./v2"
import { clipPolygonToBbox, polygonAreaM2 } from "./useCellsApi"
import { metersPerPixel } from "./CrashMap"

/** Camera fields `clippedAreaPx` needs — a structural subset of
 *  `ViewState` so callers (and tests) needn't build a full one. */
export interface BudgetView {
    latitude: number
    longitude: number
    zoom: number
    pitch: number
}

/** Closed rectangle ring (`[lng,lat][]`, first==last) from a
 *  `[minLng,minLat,maxLng,maxLat]` bbox — a stand-in "scope polygon" for
 *  statewide, which has no single outline feature (its `outline` is the
 *  21-county collection). */
export function bboxRing([w, s, e, n]: [number, number, number, number]): [number, number][] {
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]
}

/** Raw viewport area (px²) reduced to the on-screen area of `clipRing ∩
 *  viewport`. No-op (returns `rawAreaPx`) when there's no ring or no
 *  camera, or when the ring covers the whole viewport (zoomed inside the
 *  scope) — so it only ever *shrinks* the budget area, never grows it. */
export function clippedAreaPx(
    rawAreaPx: number,
    clipRing: [number, number][] | undefined,
    view: BudgetView | null,
    vpw: number,
    vph: number,
): number {
    if (!clipRing || !view) return rawAreaPx
    const vpBbox = bboxFromViewport(view.latitude, view.longitude, view.zoom, vpw, vph, view.pitch)
    const visible = clipPolygonToBbox(clipRing, vpBbox)
    const mppx = metersPerPixel(view.zoom, view.latitude)
    const clipPx = polygonAreaM2(visible) / (mppx * mppx)
    return clipPx > 0 ? Math.min(rawAreaPx, clipPx) : rawAreaPx
}
