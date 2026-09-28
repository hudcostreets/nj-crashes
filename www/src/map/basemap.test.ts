import { describe, expect, it } from "vitest"
import { basemapAuthStatus, rasterStyle } from "./basemap"

/** Dev builds append `?api_key=…` when `STADIA_TOKEN` is set; strip it so the test is env-independent. */
function unkeyed(style: any) {
    const { stadia } = style.sources
    return { ...style, sources: { ...style.sources, stadia: { ...stadia, tiles: stadia.tiles.map((t: string) => t.replace(/\?api_key=.*$/, "")) } } }
}

describe("rasterStyle", () => {
    it("is a single, unmodified Stadia raster layer (no paint/opacity that could hide it)", () => {
        expect(unkeyed(rasterStyle("dark"))).toEqual({
            version: 8,
            sources: {
                stadia: {
                    type: "raster",
                    tiles: ["https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}@2x.png"],
                    tileSize: 256,
                    attribution: expect.any(String),
                },
            },
            layers: [{ id: "stadia", type: "raster", source: "stadia" }],
        })
        expect(unkeyed(rasterStyle("light")).sources.stadia.tiles).toEqual([
            "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}@2x.png",
        ])
    })
})

describe("basemapAuthStatus", () => {
    const ajax = (status: number) => Object.assign(new Error("AJAXError"), { status })
    it("flags refused basemap tiles", () => {
        expect(basemapAuthStatus({ error: ajax(401), sourceId: "stadia" })).toBe(401)
        expect(basemapAuthStatus({ error: ajax(403), sourceId: "stadia" })).toBe(403)
        expect(basemapAuthStatus({ error: ajax(401) })).toBe(401)
    })
    it("ignores other errors and other sources", () => {
        expect(basemapAuthStatus({ error: ajax(404), sourceId: "stadia" })).toBe(null)
        expect(basemapAuthStatus({ error: ajax(500), sourceId: "stadia" })).toBe(null)
        expect(basemapAuthStatus({ error: ajax(401), sourceId: "other" })).toBe(null)
        expect(basemapAuthStatus({ error: new Error("style") })).toBe(null)
        expect(basemapAuthStatus({})).toBe(null)
    })
})
