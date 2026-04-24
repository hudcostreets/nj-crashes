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
import { latLngToCell, cellToBoundary } from "h3-js"
import { ColumnLayer } from "@deck.gl/layers/typed"
import type { PickingInfo } from "@deck.gl/core/typed"

export type StackableCrash = {
    lon: number
    lat: number
    severity: "i" | "f" | "p"
    tk: number
    pk: number
    pi: number
    /** Optional route/road label, used to populate `topRoute` in the
     *  client-side binning path. Server-side aggregates carry it
     *  precomputed as the per-bin mode. */
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
        const rt = (c.route ?? "").trim()
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
}

export function buildStackedHexLayer({
    id,
    segments,
    resolution,
    pickable,
    onHover,
    elevationScale = 1,
}: {
    id: string
    segments: Segment[]
    resolution: number
    pickable?: boolean
    onHover?: (info: PickingInfo) => boolean | void
    elevationScale?: number
}): ColumnLayer<Segment> {
    return new ColumnLayer<Segment>({
        id,
        data: segments,
        diskResolution: 6,                      // hexagonal cross-section
        radius: H3_RADIUS_METERS[resolution] ?? 174,
        radiusUnits: "meters",
        extruded: true,
        pickable: !!pickable,
        // Note: position includes altitude (baseZ) as the 3rd coord. DeckGL's
        // ColumnLayer uses `instancePositions.z` as the column's base z.
        getPosition: (s) => s.center,
        getFillColor: (s) => s.color,
        getElevation: (s) => s.height,
        elevationScale,
        material: false,
        onHover,
    })
}
