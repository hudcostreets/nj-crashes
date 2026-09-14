import { ScatterplotLayer } from "@deck.gl/layers"

/** A `ScatterplotLayer` whose discs have a radial Gaussian alpha falloff
 *  instead of a flat fill, so each cell renders as a soft density kernel that
 *  blends with its neighbors into a continuous surface rather than a hard
 *  "bokeh" circle. Used by heatmap render strategy B (`?hr=b`).
 *
 *  This is *not* a per-frame aggregation (unlike `HeatmapLayer`): the kernel is
 *  a fragment-shader shape on a normal instanced disc, so pan/zoom is a pure
 *  GPU redraw. The disc radius is drawn larger than the cell so the falloff's
 *  tail reaches neighbors; `geometry.uv` is the fragment's position within the
 *  disc (0 at center → length 1 at the drawn edge).
 */
export class SoftDiscLayer extends ScatterplotLayer {
    getShaders() {
        const shaders = super.getShaders()
        return {
            ...shaders,
            inject: {
                ...(shaders.inject ?? {}),
                "fs:DECKGL_FILTER_COLOR": `
                    float distToCenter = length(geometry.uv);
                    color.a *= exp(-3.0 * distToCenter * distToCenter);
                `,
            },
        }
    }
}
SoftDiscLayer.layerName = "SoftDiscLayer"
