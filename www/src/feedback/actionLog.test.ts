import { describe, expect, it } from "vitest"
import { ActionLog, describeControl, describeSelectChange, paramDiff, RingBuffer } from "./actionLog"

describe("RingBuffer", () => {
    it("keeps insertion order below capacity", () => {
        const r = new RingBuffer<number>(3)
        r.push(1)
        r.push(2)
        expect(r.toArray()).toEqual([1, 2])
        expect(r.size).toBe(2)
        expect(r.last()).toBe(2)
    })

    it("drops the oldest past capacity, across several wraps", () => {
        const r = new RingBuffer<number>(3)
        for (let i = 1; i <= 8; i++) r.push(i)
        expect(r.toArray()).toEqual([6, 7, 8])
        expect(r.size).toBe(3)
        expect(r.last()).toBe(8)
    })

    it("replaceLast overwrites the newest entry after wrapping", () => {
        const r = new RingBuffer<number>(3)
        for (let i = 1; i <= 4; i++) r.push(i)
        r.replaceLast(40)
        expect(r.toArray()).toEqual([2, 3, 40])
    })

    it("empty: last/replaceLast/clear", () => {
        const r = new RingBuffer<number>(2)
        expect(r.last()).toBe(undefined)
        r.replaceLast(1)
        expect(r.toArray()).toEqual([])
        r.push(1)
        r.clear()
        expect(r.toArray()).toEqual([])
    })

    it("rejects non-positive capacity", () => {
        expect(() => new RingBuffer(0)).toThrow("RingBuffer capacity must be positive, got 0")
    })
})

describe("ActionLog", () => {
    it("coalesces consecutive entries with the same key only", () => {
        const log = new ActionLog(10)
        log.log("nav", "/map", { now: 1 })
        log.log("param", "llz: a → b", { coalesceKey: "param:llz", now: 2 })
        log.log("param", "llz: b → c", { coalesceKey: "param:llz", now: 3 })
        log.log("param", "road: ∅ → 7", { coalesceKey: "param:road", now: 4 })
        log.log("param", "llz: c → d", { coalesceKey: "param:llz", now: 5 })
        expect(log.entries()).toEqual([
            { t: 1, kind: "nav", label: "/map" },
            { t: 3, kind: "param", label: "llz: b → c" },
            { t: 4, kind: "param", label: "road: ∅ → 7" },
            { t: 5, kind: "param", label: "llz: c → d" },
        ])
    })

    it("truncates labels and respects capacity", () => {
        const log = new ActionLog(2)
        log.log("click", "x".repeat(250), { now: 1 })
        log.log("click", "b", { now: 2 })
        log.log("click", "c", { now: 3 })
        expect(log.entries()).toEqual([
            { t: 2, kind: "click", label: "b" },
            { t: 3, kind: "click", label: "c" },
        ])
        log.clear()
        log.log("click", "x".repeat(250), { now: 4 })
        expect(log.entries()).toEqual([{ t: 4, kind: "click", label: "x".repeat(200) }])
    })
})

describe("paramDiff", () => {
    it("reports added, removed, and changed params, sorted by key", () => {
        expect(paramDiff("?road=12&sev=f&llz=1,2,3", "?sev=fi&llz=1,2,3&mode=bins")).toEqual([
            ["mode", "mode: ∅ → bins"],
            ["road", "road: 12 → ∅"],
            ["sev", "sev: f → fi"],
        ])
    })

    it("valueless params are distinct from absent ones", () => {
        expect(paramDiff("", "?fs")).toEqual([["fs", "fs: ∅ → "]])
    })

    it("no changes", () => {
        expect(paramDiff("?a=1&b=2", "?b=2&a=1")).toEqual([])
    })

    it("truncates long values", () => {
        expect(paramDiff("", `?q=${"z".repeat(70)}`)).toEqual([["q", `q: ∅ → ${"z".repeat(60)}…`]])
    })
})

function dom(html: string): HTMLElement {
    const root = document.createElement("div")
    root.innerHTML = html
    document.body.replaceChildren(root)
    return root
}

describe("describeControl", () => {
    it("button text, from a nested icon/span", () => {
        const root = dom(`<button><svg></svg><span id="t">Heatmap</span></button>`)
        expect(describeControl(root.querySelector("#t")!)).toBe(`button "Heatmap"`)
    })

    it("aria-label wins over text", () => {
        const root = dom(`<button aria-label="Zoom in">+</button>`)
        expect(describeControl(root.querySelector("button")!)).toBe(`button "Zoom in"`)
    })

    it("links include their href", () => {
        const root = dom(`<a href="/road/hudson/jersey-city/rt-139">Rt 139</a>`)
        expect(describeControl(root.querySelector("a")!)).toBe(`a "Rt 139" → /road/hudson/jersey-city/rt-139`)
    })

    it("checkbox: label text + state", () => {
        const root = dom(`<label><input type="checkbox" checked> Fatal</label>`)
        expect(describeControl(root.querySelector("input")!)).toBe(`checkbox "Fatal" (on)`)
    })

    it("role + aria-checked", () => {
        const root = dom(`<div role="switch" aria-checked="false">Dark mode</div>`)
        expect(describeControl(root.querySelector("div")!)).toBe(`switch "Dark mode" (off)`)
    })

    it("falls back to title / id for icon-only controls", () => {
        const root = dom(`<button title="Settings"><svg></svg></button><button id="gear"></button>`)
        const [a, b] = root.querySelectorAll("button")
        expect([describeControl(a), describeControl(b)]).toEqual([`button "Settings"`, `button "#gear"`])
    })

    it("non-controls and ignored subtrees → null", () => {
        const root = dom(`<p id="p">text</p><div data-feedback-ignore><button id="b">Send</button></div>`)
        expect([describeControl(root.querySelector("#p")!), describeControl(root.querySelector("#b")!)]).toEqual([null, null])
    })
})

describe("describeSelectChange", () => {
    it("aria-label + selected option text", () => {
        const root = dom(`<select aria-label="County"><option value="1">Atlantic</option><option value="9" selected>Hudson</option></select>`)
        expect(describeSelectChange(root.querySelector("select")!)).toBe(`select "County" = Hudson`)
    })

    it("non-select → null", () => {
        const root = dom(`<input type="text">`)
        expect(describeSelectChange(root.querySelector("input")!)).toBe(null)
    })
})
