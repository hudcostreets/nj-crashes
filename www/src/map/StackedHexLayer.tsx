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

/** Grid-agnostic client-side binner. `toCell` maps a crash's lat/lon to
 *  its cell token at the desired resolution; `toCenter` maps a token to
 *  its [lon, lat] center. `binIntoHexes` (H3) and `binIntoS2Cells`
 *  (`map/s2`) are thin wrappers — the aggregation (severity tiers,
 *  per-bin `topRoute` mode) lives here once. */
export function binIntoCells<T extends StackableCrash>(
    crashes: T[],
    toCell: (lat: number, lon: number) => string,
    toCenter: (cell: string) => [number, number],
): StackedHex[] {
    const bins = new Map<string, StackedHex>()
    // Per-bin route counts to pick the mode after aggregation.
    const routeCounts = new Map<string, Map<string, number>>()
    for (const c of crashes) {
        const h3 = toCell(c.lat, c.lon)
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
        b.center = toCenter(b.h3)
        const m = routeCounts.get(b.h3)
        if (m && m.size > 0) {
            let topR = "", topN = 0
            for (const [r, n] of m) { if (n > topN) { topR = r; topN = n } }
            b.topRoute = topR
        }
    }
    return [...bins.values()]
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

/** S2 cell edge length by level, in meters. Matches `S2_DIAMETER_METERS`
 *  in `map/s2/index.ts`; duplicated here to keep this layer module free
 *  of a runtime `nodes2ts` dep. Keep in sync. */
const S2_EDGE_METERS: Record<number, number> = {
    4: 490_000, 5: 245_000, 6: 122_500, 7: 61_250, 8: 30_625,
    9: 15_312, 10: 7_656, 11: 3_828, 12: 1_914, 13: 957,
    14: 478, 15: 239, 16: 120, 17: 60, 18: 30, 19: 15, 20: 7.5, 21: 3.75,
}

export function buildStackedHexLayer({
    id,
    segments,
    resolution,
    pickable,
    onHover,
    elevationScale = 1,
    overrideRadiusMeters,
    opacity = 1,
    desaturate = 0,
}: {
    id: string
    segments: Segment[]
    /** S2 level of the cell tokens — drives the column radius lookup. */
    resolution: number
    pickable?: boolean
    onHover?: (info: PickingInfo) => boolean | void
    elevationScale?: number
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
    // Circular column cross-section, radius from the caller's smooth
    // `target_px(z)` curve, clamped to the cell's inscribed-circle radius
    // (edge / 2) so adjacent occupied cells never overlap. We deliberately
    // never draw raw S2 cell polygons — on the ground they're sheared
    // parallelograms (~80° axes, ~10° tilt at NJ's spot on the cube face),
    // which read as visual noise rather than a grid.
    const edge = S2_EDGE_METERS[resolution] ?? 478
    const inscribed = edge / 2
    const diskResolution = 24
    const radius = Math.min(overrideRadiusMeters ?? inscribed, inscribed)
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
