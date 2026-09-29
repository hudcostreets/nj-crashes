import { describe, expect, it } from "vitest"
import { toolboxOpenFromUrl } from "./useToolboxOpen"

describe("toolboxOpenFromUrl", () => {
    it("reads `st=1` / `st=0`; anything else defers to the default", () => {
        expect(["?st=1", "?y=11-13&st=0", "", "?st=", "?st=yes"].map(toolboxOpenFromUrl)).toEqual([true, false, null, null, null])
    })
})
