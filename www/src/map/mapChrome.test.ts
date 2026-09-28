import { describe, it, expect } from "vitest"
import { mapChrome } from "./mapChrome"

describe("mapChrome", () => {
    it("wide maps keep the centered title and top-right drawer", () => {
        for (const w of [640, 844, 1280]) {
            expect(mapChrome(w, 28)).toEqual({
                narrow: false, homeIconOnly: false, title: { centered: true },
                legendTop: 42, drawerTop: 8, drawerDefaultOpen: true,
            })
        }
    })

    it("narrow maps pin the title between home icon and ⚙, stack legend + drawer below it", () => {
        expect(mapChrome(390, 54)).toEqual({
            narrow: true, homeIconOnly: true, title: { centered: false, left: 44, right: 72 },
            legendTop: 68, drawerTop: 68, drawerDefaultOpen: false,
        })
        // One-line title: the legend keeps its usual 42 px slot.
        expect(mapChrome(430, 28)).toEqual({
            narrow: true, homeIconOnly: true, title: { centered: false, left: 44, right: 72 },
            legendTop: 42, drawerTop: 42, drawerDefaultOpen: false,
        })
    })
})
