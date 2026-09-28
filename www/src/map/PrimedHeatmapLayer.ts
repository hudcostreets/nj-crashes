/** deck.gl `HeatmapLayer` whose first weight map is usable.
 *
 *  The first weight-splat pass a `HeatmapLayer` runs after it initializes comes out wrong (deck.gl
 *  9.3.2 / luma.gl 9.3.3): the splats pile into a few texels (max-weight texel ≈12.7k with ~63
 *  overlapping points, vs ≈5.1k / ~4 from any later pass over the same data and view), so the
 *  whole surface normalizes under the color threshold and nothing draws. Any later pass is right.
 *  It went unnoticed while the heatmap got a new `data` array on nearly every render (each one a
 *  fresh splat); since `stableClip` keeps the data's identity, the layer's only pass is that first
 *  one, until the next data / bounds change (specs/map-mobile-perf.md § Round 2, "Heatmap drew
 *  nothing"). So: run the layer's first weight-map update twice. */
import { HeatmapLayer } from "@deck.gl/aggregation-layers"

export class PrimedHeatmapLayer<DataT = unknown> extends HeatmapLayer<DataT> {
    static layerName = "PrimedHeatmapLayer"

    override _updateWeightmap(): void {
        super._updateWeightmap()
        const state = this.state as { weightmapPrimed?: boolean }
        if (state.weightmapPrimed) return
        state.weightmapPrimed = true
        super._updateWeightmap()
    }
}
