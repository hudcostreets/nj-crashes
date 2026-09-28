import { afterEach, describe, expect, it, vi } from "vitest"
import { HeatmapLayer } from "@deck.gl/aggregation-layers"
import { PrimedHeatmapLayer } from "./PrimedHeatmapLayer"

describe("PrimedHeatmapLayer", () => {
    afterEach(() => { vi.restoreAllMocks() })

    it("runs the layer's first weight-map update twice, later ones once", () => {
        const base = vi.spyOn(HeatmapLayer.prototype, "_updateWeightmap").mockImplementation(() => {})
        const layer = new PrimedHeatmapLayer({ id: "heat", data: [] })
        // deck.gl carries `state` across a layer's re-created instances; one object stands in.
        const state = {}
        Object.defineProperty(layer, "state", { value: state })
        const passes: number[] = []
        for (let i = 0; i < 3; i++) {
            const before = base.mock.calls.length
            layer._updateWeightmap()
            passes.push(base.mock.calls.length - before)
        }
        expect(passes).toEqual([2, 1, 1])
        expect(state).toEqual({ weightmapPrimed: true })
    })
})
