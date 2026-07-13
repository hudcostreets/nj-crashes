/** Stacked hex-column layer: per-hex cylinder split into colored segments
 *  stacked by severity. Fatal on top, injury below.
 *
 *  (The hex data still tracks ped/cyclist vs. other injury separately; that
 *  distinction is available in tooltips if a caller wants to render it, but
 *  the segments collapse both into a single "injury" tier by default so the
 *  palette lines up with the bar-chart legend.)
 *
 *  Implementation: emit one `ColumnLayer` instance per (hex, severity tier).
 *  `getPosition` includes a 3D altitude (the segment's base-z), and
 *  `getElevation` is the segment's height. DeckGL's ColumnLayer shader
 *  computes `centroidPosition = vec3(xy, z + elevation)` so the column
 *  extrudes from `baseZ` up to `baseZ + height` — which gives us stacked
 *  segments with no shader mods.
 */
import { latLngToCell, cellToBoundary, cellToParent, getResolution } from "h3-js"
import { ColumnLayer } from "@deck.gl/layers"
import type { PickingInfo } from "@deck.gl/core"

export type StackableCrash = {
    lon: number
    lat: number
    severity: "i" | "f" | "p"
    tk: number
    pk: number
    pi: number
    /** Optional human-readable road label ("CALDERON AVENUE", "ROUTE 9").
     *  Used to populate `topRoute` in the client-side binning path.
     *  Server-side aggregates carry it precomputed as the per-bin mode. */
    road?: string | null
    /** Numeric route fallback when `road` is empty. */
    route?: string | null
}

export type StackedHex = {
    h3: string
    center: [number, number]
    fatal: number
    pedInj: number
    otherInj: number
    pdo: number
    total: number
    /** Most common `route` value among the crashes in this bin. Empty
     *  string when no crash had a route value (or the dataset doesn't
     *  carry it). */
    topRoute?: string
    /** Years (ascending) in which this bin had ≥1 fatal crash. Sourced
     *  from the cells-api per-cell breakdown. Used by the tooltip to
     *  show "Fatal: 2018, 2020" instead of just a bare count. */
    fatalYears?: number[]
    /** Sidecar labels multiplexed onto the cells-api response by the
     *  worker (`pyramid_sld/` join). Present on server-sourced cells;
     *  absent on the client-binned points/scatter fallback path. */
    sld_name?: string
    cross_sld_name?: string
    mun?: string
    county?: string
}

export type Segment = {
    center: [number, number, number]  // [lon, lat, baseZ]
    height: number
    color: [number, number, number, number]
    hex: StackedHex
    tier: "fatal" | "injury" | "pdo"
}

export function binIntoHexes<T extends StackableCrash>(
    crashes: T[],
    resolution: number = 9,
): StackedHex[] {
    const bins = new Map<string, StackedHex>()
    // Per-bin route counts to pick the mode after aggregation.
    const routeCounts = new Map<string, Map<string, number>>()
    for (const c of crashes) {
        const h3 = latLngToCell(c.lat, c.lon, resolution)
        let b = bins.get(h3)
        if (!b) {
            b = { h3, center: [0, 0], fatal: 0, pedInj: 0, otherInj: 0, pdo: 0, total: 0 }
            bins.set(h3, b)
        }
        b.total += 1
        if (c.severity === "f" || c.tk > 0) b.fatal += 1
        else if (c.severity === "i" && (c.pi > 0 || c.pk > 0)) b.pedInj += 1
        else if (c.severity === "i") b.otherInj += 1
        else b.pdo += 1
        const rt = (c.road ?? "").trim() || (c.route ? `Route ${c.route}` : "")
        if (rt) {
            let m = routeCounts.get(h3)
            if (!m) { m = new Map(); routeCounts.set(h3, m) }
            m.set(rt, (m.get(rt) ?? 0) + 1)
        }
    }
    for (const b of bins.values()) {
        const boundary = cellToBoundary(b.h3, true)
        let lon = 0, lat = 0
        for (const [ln, la] of boundary) { lon += ln; lat += la }
        b.center = [lon / boundary.length, lat / boundary.length]
        const m = routeCounts.get(b.h3)
        if (m && m.size > 0) {
            let topR = "", topN = 0
            for (const [r, n] of m) { if (n > topN) { topR = r; topN = n } }
            b.topRoute = topR
        }
    }
    return [...bins.values()]
}

/** Re-aggregate a finer-resolution hex set into coarser parents.
 *  H3 parent containment is exact: every cell at res N has exactly one
 *  parent at any res < N, so summing children → parents is lossless.
 *  No-op when `targetRes >= sourceRes` (we can't synthesize finer data).
 *  `topRoute` resolves by weighted vote — each child's topRoute counted
 *  by that child's total. */
export function coarsenHexes(hexes: StackedHex[], targetRes: number): StackedHex[] {
    if (hexes.length === 0) return hexes
    const sourceRes = getResolution(hexes[0].h3)
    if (targetRes >= sourceRes) return hexes
    const parents = new Map<string, StackedHex>()
    const routeVotes = new Map<string, Map<string, number>>()
    for (const h of hexes) {
        const ph3 = cellToParent(h.h3, targetRes)
        let p = parents.get(ph3)
        if (!p) {
            p = { h3: ph3, center: [0, 0], fatal: 0, pedInj: 0, otherInj: 0, pdo: 0, total: 0 }
            parents.set(ph3, p)
        }
        p.fatal += h.fatal
        p.pedInj += h.pedInj
        p.otherInj += h.otherInj
        p.pdo += h.pdo
        p.total += h.total
        if (h.topRoute) {
            let m = routeVotes.get(ph3)
            if (!m) { m = new Map(); routeVotes.set(ph3, m) }
            m.set(h.topRoute, (m.get(h.topRoute) ?? 0) + h.total)
        }
        if (h.fatalYears && h.fatalYears.length > 0) {
            (p.fatalYears ??= []).push(...h.fatalYears)
        }
    }
    for (const p of parents.values()) {
        const boundary = cellToBoundary(p.h3, true)
        let lon = 0, lat = 0
        for (const [ln, la] of boundary) { lon += ln; lat += la }
        p.center = [lon / boundary.length, lat / boundary.length]
        const m = routeVotes.get(p.h3)
        if (m && m.size > 0) {
            let topR = "", topN = 0
            for (const [r, n] of m) { if (n > topN) { topR = r; topN = n } }
            p.topRoute = topR
        }
        if (p.fatalYears) p.fatalYears = [...new Set(p.fatalYears)].sort((a, b) => a - b)
    }
    return [...parents.values()]
}

export function hexesToSegments(
    hexes: StackedHex[],
    elevationPerCount = 15,
    colors = {
        pdo:    [235, 218, 108, 120] as [number, number, number, number],  // pale yellow (matches bar-chart "Prop. Damage")
        injury: [245, 158, 11, 140]  as [number, number, number, number],  // orange ("Injury")
        fatal:  [210, 28, 28, 220]   as [number, number, number, number],  // red ("Fatal")
    },
): Segment[] {
    const segs: Segment[] = []
    for (const h of hexes) {
        let z = 0
        const push = (tier: Segment["tier"], count: number, color: Segment["color"]) => {
            if (count <= 0) return
            const dz = count * elevationPerCount
            segs.push({ center: [h.center[0], h.center[1], z], height: dz, color, hex: h, tier })
            z += dz
        }
        push("pdo", h.pdo, colors.pdo)
        push("injury", h.pedInj + h.otherInj, colors.injury)
        push("fatal", h.fatal, colors.fatal)
    }
    return segs
}

/** H3 cell edge length by resolution (approx; avg across cells). */
export const H3_RADIUS_METERS: Record<number, number> = {
    5: 8544,
    6: 3229,
    7: 1220,
    8: 461,
    9: 174,
    10: 66,
    11: 25,
    12: 9.4,
    13: 3.6,
    14: 1.4,
    15: 0.54,  // r14 / ~2.6 (per-level H3 radius ratio)
}

/** `hex` — full h3-hex cross-section, radius = edge length so vertices
 *  touch neighboring cells (classic tessellation).
 *
 *  `circle` — circular cross-section with `overrideRadiusMeters`, clamped
 *  to the current cell's inscribed-circle radius (edge × √3/2) so
 *  adjacent circles never overlap. Combined with a smooth `target_px(z)`
 *  curve at the callsite, this yields no visual jump at res transitions:
 *  transitions happen when the target radius equals the finer cell's
 *  inscribed radius, so before/after both render at the same size. */
export type VizMode = "hex" | "circle"

/** S2 cell edge length by level, in meters. Matches `S2_DIAMETER_METERS`
 *  in `map/s2/index.ts`; duplicated here to avoid a `map/s2` import from
 *  the shared layer module (no runtime dep on nodes2ts if only h3 mode
 *  is in use). Keep in sync. */
const S2_EDGE_METERS: Record<number, number> = {
    4: 490_000, 5: 245_000, 6: 122_500, 7: 61_250, 8: 30_625,
    9: 15_312, 10: 7_656, 11: 3_828, 12: 1_914, 13: 957,
    14: 478, 15: 239, 16: 120, 17: 60, 18: 30, 19: 15, 20: 7.5, 21: 3.75,
}

export function buildStackedHexLayer({
    id,
    segments,
    resolution,
    grid = "h3",
    pickable,
    onHover,
    elevationScale = 1,
    viz = "hex",
    overrideRadiusMeters,
    opacity = 1,
    desaturate = 0,
}: {
    id: string
    segments: Segment[]
    resolution: number
    /** Which grid the cell tokens belong to. Controls the column
     *  radius lookup (H3 hex edge vs. S2 average cell edge). H3
     *  is the default so existing callers don't need to change. */
    grid?: "h3" | "s2"
    pickable?: boolean
    onHover?: (info: PickingInfo) => boolean | void
    elevationScale?: number
    viz?: VizMode
    overrideRadiusMeters?: number
    /** Multiplies each column's fill alpha. Used by the section to fade
     *  the currently-rendered layer while a fresh /cells fetch is in
     *  flight — gives an immediate "this is stale" signal during 5-20s
     *  wide-viewport reqs without a modal spinner. */
    opacity?: number
    /** 0 = untouched, 1 = fully luminance-grey. Applied in combination
     *  with `opacity` while a fetch is in flight so the fatal/injury/other
     *  signal remains readable but is clearly de-emphasized. */
    desaturate?: number
}): ColumnLayer<Segment> {
    const edge = grid === "s2"
        ? (S2_EDGE_METERS[resolution] ?? 478)
        : (H3_RADIUS_METERS[resolution] ?? 174)
    let diskResolution: number
    let radius: number
    // Inscribed-circle radius of the cell (used as the no-overlap ceiling):
    // `edge × √3/2` for a hex (H3), `edge / 2` for a square (S2).
    const inscribed = grid === "s2" ? edge / 2 : edge * Math.sqrt(3) / 2
    if (viz === "circle") {
        diskResolution = 24
        radius = Math.min(overrideRadiusMeters ?? inscribed, inscribed)
    } else if (grid === "s2") {
        // "Squares" viz on S2 — matches Circle viz sizing so toggling
        // shape doesn't jump area, just changes the column footprint
        // from round to square (4-sided disk).
        diskResolution = 4
        radius = Math.min(overrideRadiusMeters ?? inscribed, inscribed)
    } else {
        // "Hex" viz on H3 — cell-fill tessellation. `radius = edge` puts
        // the six vertices on a circle-of-radius-edge, so the hex has
        // side = edge (matches the H3 cell) and neighbours touch.
        diskResolution = 6
        radius = edge
    }
    const getFillColor = desaturate > 0
        ? (s: Segment): [number, number, number] | [number, number, number, number] => {
            const [r, g, b, a] = s.color as [number, number, number, number]
            const lum = 0.299 * r + 0.587 * g + 0.114 * b
            return [
                r + (lum - r) * desaturate,
                g + (lum - g) * desaturate,
                b + (lum - b) * desaturate,
                a,
            ]
        }
        : (s: Segment) => s.color
    return new ColumnLayer<Segment>({
        id,
        data: segments,
        diskResolution,
        radius,
        radiusUnits: "meters",
        extruded: true,
        pickable: !!pickable,
        // Note: position includes altitude (baseZ) as the 3rd coord. DeckGL's
        // ColumnLayer uses `instancePositions.z` as the column's base z.
        getPosition: (s) => s.center,
        getFillColor,
        updateTriggers: { getFillColor: [desaturate] },
        getElevation: (s) => s.height,
        elevationScale,
        material: false,
        opacity,
        onHover,
    })
}
