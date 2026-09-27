import { describe, expect, it } from "vitest"
import { buildReport, toFormData, validateForm, type ReportContext } from "./payload"
import { shotScale } from "./screenshot"

const context: ReportContext = {
    viewport: { w: 1440, h: 900, dpr: 2 },
    ua: "UA",
    theme: "system",
    actualTheme: "dark",
    buildSha: "abc123",
    tz: "America/New_York",
    ts: 1000,
}

describe("validateForm", () => {
    it.each([
        [{ comment: "Broken legend", email: "" }, {}],
        [{ comment: "  ", email: "" }, { comment: "Please describe the issue." }],
        [{ comment: "ok", email: "a@b.co" }, {}],
        [{ comment: "ok", email: "nope" }, { email: "That doesn't look like an email address." }],
        [{ comment: "", email: "a@b" }, { comment: "Please describe the issue.", email: "That doesn't look like an email address." }],
    ])("%j → %j", (form, want) => {
        expect(validateForm(form)).toEqual(want)
    })

    it("length limit", () => {
        expect(validateForm({ comment: "x".repeat(11), email: "" }, { comment: 10, email: 254 })).toEqual({
            comment: "Please keep it under 10 characters (currently 11).",
        })
    })
})

describe("buildReport", () => {
    it("trims, nulls empty email, keeps the last 100 actions", () => {
        const actions = Array.from({ length: 105 }, (_, i) => ({ t: i, kind: "click" as const, label: `b${i}` }))
        const r = buildReport({
            form: { comment: "  legend overlaps  ", email: "  " },
            href: "https://crashes.hccs.dev/map?road=1",
            context,
            actions,
            turnstileToken: null,
        })
        expect(r).toEqual({
            v: 1,
            comment: "legend overlaps",
            email: null,
            url: "https://crashes.hccs.dev/map?road=1",
            context,
            actions: actions.slice(5),
            turnstileToken: null,
        })
    })
})

describe("toFormData", () => {
    it("report JSON + screenshot file", async () => {
        const report = buildReport({ form: { comment: "c", email: "e@x.io" }, href: "https://x.io/", context, actions: [], turnstileToken: "tok" })
        const fd = toFormData(report, new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }))
        expect(JSON.parse(fd.get("report") as string)).toEqual(report)
        const file = fd.get("screenshot") as File
        expect([file.name, file.type, file.size]).toEqual(["screenshot.webp", "image/webp", 3])
    })

    it("no screenshot", () => {
        const report = buildReport({ form: { comment: "c", email: "" }, href: "https://x.io/", context, actions: [], turnstileToken: null })
        expect([...toFormData(report, null).keys()]).toEqual(["report"])
    })
})

describe("shotScale", () => {
    it.each([
        [1440, 2, 1600 / 1440],
        [1440, 1, 1],
        [390, 3, 3],
        [800, 2, 2],
        [3200, 1, 0.5],
    ])("vw=%d dpr=%d → %f", (vw, dpr, want) => {
        expect(shotScale(vw, dpr)).toBe(want)
    })
})
