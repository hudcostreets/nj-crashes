import { describe, expect, it } from "vitest"
import { mapViewHref } from "./links"

describe("mapViewHref", () => {
    it("encodes a signed-delimited top-down view", () => {
        expect(mapViewHref({ lat: 40.720412, lon: -74.084349, zoom: 16 })).toEqual("/map?llz=40.7204-74.0843+16.00+0+0")
    })

    it("appends the selected road's slug, with unescaped slashes", () => {
        expect(mapViewHref({ lat: 40.72, lon: -74.08, zoom: 13.745, road: "hudson/jersey-city/west-side-avenue" }))
            .toEqual("/map?llz=40.7200-74.0800+13.74+0+0&road=hudson/jersey-city/west-side-avenue")
    })
})
