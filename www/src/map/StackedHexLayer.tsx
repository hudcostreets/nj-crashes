/** Stacked hex-column layer: per-hex cylinder split into colored segments
 *  stacked by severity. Fatal on top, pedestrian/cyclist injury in middle,
 *  other injury at bottom.
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
    severity: "i" | "f"
    tk: number
    pk: number
    pi: number
}

export type StackedHex = {
    h3: string
    center: [number, number]
    fatal: number
    pedInj: number
    otherInj: number
    total: number
}

export type Segment = {
    center: [number, number, number]  // [lon, lat, baseZ]
    height: number
    color: [number, number, number, number]
    hex: StackedHex
    tier: "fatal" | "pedInj" | "otherInj"
}

export function binIntoHexes<T extends StackableCrash>(
    crashes: T[],
    resolution: number = 9,
): StackedHex[] {
    const bins = new Map<string, StackedHex>()
    for (const c of crashes) {
        const h3 = latLngToCell(c.lat, c.lon, resolution)
        let b = bins.get(h3)
        if (!b) {
            b = { h3, center: [0, 0], fatal: 0, pedInj: 0, otherInj: 0, total: 0 }
            bins.set(h3, b)
        }
        b.total += 1
        if (c.severity === "f" || c.tk > 0) b.fatal += 1
        else if (c.pi > 0 || c.pk > 0) b.pedInj += 1
        else b.otherInj += 1
    }
    for (const b of bins.values()) {
        const boundary = cellToBoundary(b.h3, true)
        let lon = 0, lat = 0
        for (const [ln, la] of boundary) { lon += ln; lat += la }
        b.center = [lon / boundary.length, lat / boundary.length]
    }
    return [...bins.values()]
}

export function hexesToSegments(
    hexes: StackedHex[],
    elevationPerCount = 15,
    colors = {
        otherInj: [247, 237, 108, 110] as [number, number, number, number],  // pale yellow, low alpha
        pedInj:   [253, 140, 60, 160]  as [number, number, number, number],  // orange, mid alpha
        fatal:    [210, 28, 28, 200]   as [number, number, number, number],  // red, translucent so stacked fatals read as darker bands
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
        push("otherInj", h.otherInj, colors.otherInj)
        push("pedInj", h.pedInj, colors.pedInj)
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
