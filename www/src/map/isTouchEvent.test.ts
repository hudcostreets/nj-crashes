import { describe, expect, it } from "vitest"
import { isTouchEvent } from "./CrashMap"

describe("isTouchEvent", () => {
    it("classifies pointer types and missing events", () => {
        const pe = (pointerType: string) => ({ pointerType }) as unknown as Event
        expect([pe("touch"), pe("mouse"), pe("pen"), undefined, null].map(isTouchEvent))
            .toEqual([true, false, false, false, false])
    })
})
