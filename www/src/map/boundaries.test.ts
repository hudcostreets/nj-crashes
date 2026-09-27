import { describe, expect, it } from "vitest"
import type { Feature } from "geojson"
import { bboxesIntersect, featureBbox, outlineLabel } from "./boundaries"

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
