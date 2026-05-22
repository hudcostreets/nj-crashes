import { describe, expect, it } from "vitest"
import { crashDetailHref } from "./crash"

describe("crashDetailHref", () => {
    it("builds the /crash SPA route from the natural PK", () => {
        expect(crashDetailHref({ year: 2023, cc: 3, mc: 38, case: "2023-00002089" }))
            .toBe("/crash/2023/3/38/2023-00002089")
    })

    it("URL-encodes slashes and spaces in the case number", () => {
        expect(crashDetailHref({ year: 2021, cc: 9, mc: 9, case: "21/AB 7" }))
            .toBe("/crash/2021/9/9/21%2FAB%207")
    })
})
