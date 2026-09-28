import { describe, expect, it } from "vitest"
import { padBbox, stableClip } from "./stableClip"

type C = { id: string; center: [number, number] }
const c = (id: string, x: number, y: number): C => ({ id, center: [x, y] })
const data: C[] = [c("a", 0, 0), c("b", 1.2, 0), c("c", 3, 3), c("d", -0.4, 0.9)]
const ids = (xs: C[]) => xs.map(x => x.id)

describe("padBbox", () => {
    it("grows each side by a fraction of the span", () => {
        expect(padBbox([0, 0, 2, 1], 0.5)).toEqual([-1, -0.5, 3, 1.5])
    })
})

describe("stableClip", () => {
    it("clips to the padded window around the viewport", () => {
        const r = stableClip<C>(null, data, [0, 0, 1, 1])
        expect(r.window).toEqual([-0.5, -0.5, 1.5, 1.5])
        expect(ids(r.cells)).toEqual(["a", "b", "d"])
    })

    it("reuses the previous clip (same object) while the viewport stays inside its window", () => {
        const r0 = stableClip<C>(null, data, [0, 0, 1, 1])
        const r1 = stableClip(r0, data, [0.3, 0.2, 1.3, 1.2])
        expect(r1).toBe(r0)
    })

    it("re-clips once the viewport leaves the window", () => {
        const r0 = stableClip<C>(null, data, [0, 0, 1, 1])
        const r1 = stableClip(r0, data, [2, 2, 3, 3])
        expect(r1 === r0).toBe(false)
        expect(r1.window).toEqual([1.5, 1.5, 3.5, 3.5])
        expect(ids(r1.cells)).toEqual(["c"])
    })

    it("re-clips when the data changes, even for the same viewport", () => {
        const r0 = stableClip<C>(null, data, [0, 0, 1, 1])
        const next = [...data, c("e", 0.5, 0.5)]
        const r1 = stableClip(r0, next, [0, 0, 1, 1])
        expect(ids(r1.cells)).toEqual(["a", "b", "d", "e"])
    })

    it("no viewport: the data itself, reused while the data is unchanged", () => {
        const r0 = stableClip<C>(null, data, null)
        expect(r0.cells).toBe(data)
        expect(stableClip(r0, data, undefined)).toBe(r0)
    })
})
