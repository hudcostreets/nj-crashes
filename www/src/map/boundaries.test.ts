import { describe, expect, it } from "vitest"
import type { Feature } from "geojson"
import { areaFillScale, bboxesIntersect, viewCoverage, featureAt, featureBbox, outlineLabel } from "./boundaries"
import type { Bbox } from "./v2"

describe("viewCoverage", () => {
    const square = (w: number, s: number, e: number, n: number): Feature => ({
        type: "Feature", properties: {},
        geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    })
    const view: Bbox = [0, 0, 1, 1]
    it("is the fraction of the view inside the polygon, not its bbox", () => {
        // An L-shaped polygon whose bbox covers the whole view but which covers 3/4 of it.
        const ell: Feature = {
            type: "Feature", properties: {},
            geometry: { type: "Polygon", coordinates: [[[-1, -1], [2, -1], [2, 0.5], [0.5, 0.5], [0.5, 2], [-1, 2], [-1, -1]]] },
        }
        expect([
            viewCoverage(square(-1, -1, 2, 2), view),
            viewCoverage(square(0, 0, 0.5, 1), view),
            viewCoverage(square(5, 5, 6, 6), view),
            viewCoverage(ell, view),
        ]).toEqual([1, 0.5, 0, 0.75])
    })
    it("degenerate view: 0", () => {
        expect(viewCoverage(square(-1, -1, 2, 2), [0, 0, 0, 0])).toBe(0)
    })
})

describe("areaFillScale", () => {
    it("is full up to 25% coverage, none from 75%, linear between", () => {
        expect([0, 0.25, 0.5, 0.75, 1].map(areaFillScale)).toEqual([1, 1, 0.5, 0, 0])
    })
})

describe("bboxesIntersect", () => {
    it("treats touching boxes as intersecting", () => {
        expect([
            bboxesIntersect([0, 0, 1, 1], [0.5, 0.5, 2, 2]),
            bboxesIntersect([0, 0, 1, 1], [1, 1, 2, 2]),
            bboxesIntersect([0, 0, 1, 1], [1.1, 0, 2, 1]),
            bboxesIntersect([0, 0, 1, 1], [0, 1.1, 1, 2]),
        ]).toEqual([true, true, false, false])
    })
})

describe("featureBbox", () => {
    it("spans all parts of a MultiPolygon", () => {
        const f: Feature = {
            type: "Feature", properties: {},
            geometry: {
                type: "MultiPolygon",
                coordinates: [
                    [[[0, 0], [2, 0], [2, 1], [0, 0]]],
                    [[[5, -3], [6, -3], [6, 4], [5, -3]]],
                ],
            },
        }
        expect(featureBbox(f)).toEqual([0, -3, 6, 4])
    })
})

describe("outlineLabel", () => {
    const feature = (properties: Record<string, unknown>): Feature => ({ type: "Feature", properties, geometry: null as any })
    it("labels munis (optionally with their county) and counties", () => {
        const jc = feature({ cc: 9, mc: 6, name: "Jersey City", label: "Jersey City" })
        const weehawken = feature({ cc: 9, mc: 11, name: "Weehawken Township", label: "Weehawken Township" })
        expect([
            outlineLabel(jc, false),
            outlineLabel(jc, true),
            outlineLabel(weehawken, true),
            outlineLabel(feature({ cc: 9, mc: 1, name: "Bayonne" }), false),
            outlineLabel(feature({ cc: 1, name: "Atlantic" }), true),
            outlineLabel(feature({}), true),
        ]).toEqual([
            "Jersey City",
            "Jersey City, Hudson County",
            "Weehawken Township, Hudson County",
            "Bayonne",
            "Atlantic County",
            null,
        ])
    })
})

describe("featureAt", () => {
    const square = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]]
    // A township with a borough-shaped hole, the borough filling the hole, and a two-part muni.
    const twp: Feature = { type: "Feature", properties: { mc: 1 }, geometry: { type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] } }
    const boro: Feature = { type: "Feature", properties: { mc: 2 }, geometry: { type: "Polygon", coordinates: [square(4, 4, 6, 6)] } }
    const split: Feature = { type: "Feature", properties: { mc: 3 }, geometry: { type: "MultiPolygon", coordinates: [[square(20, 0, 22, 2)], [square(30, 0, 32, 2)]] } }
    const features = [twp, boro, split]
    const mcAt = (lngLat: [number, number]) => featureAt(features, lngLat)?.properties?.mc ?? null

    it("hit-tests polygons, holes, and multipolygon parts", () => {
        expect([
            mcAt([1, 1]),    // township
            mcAt([5, 5]),    // in the township's hole → the borough
            mcAt([21, 1]),   // first part
            mcAt([31, 1]),   // second part
            mcAt([25, 1]),   // between the parts (inside the multipolygon's bbox)
            mcAt([50, 50]),  // outside everything
        ]).toEqual([1, 2, 3, 3, null, null])
    })
})
