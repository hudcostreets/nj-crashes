import { describe, expect, it } from "vitest"
import { muniKey } from "./county"

describe("muniKey", () => {
    it("expands NJDOT's abbreviated suffixes to the full form", () => {
        expect(muniKey("Hopewell Boro")).toBe("hopewell borough")
        expect(muniKey("Hopewell Twp")).toBe("hopewell township")
        expect(muniKey("Boro.")).toBe("borough")
        expect(muniKey("Twp.")).toBe("township")
    })

    it("leaves already-canonical names unchanged (idempotent)", () => {
        expect(muniKey("Hopewell Borough")).toBe("hopewell borough")
        expect(muniKey("Hopewell Township")).toBe("hopewell township")
        expect(muniKey("Pennington")).toBe("pennington")
        expect(muniKey(muniKey("Hopewell Boro"))).toBe("hopewell borough")
    })

    it("makes the abbreviated and full spellings resolve to the same key", () => {
        // This is the fix: muni-maps.json says "Hopewell Borough" while
        // cc2mc2mn.json says "Hopewell Boro" — both must key identically.
        expect(muniKey("Hopewell Boro")).toBe(muniKey("Hopewell Borough"))
        expect(muniKey("Hopewell Twp")).toBe(muniKey("Hopewell Township"))
    })

    it("does not collide Borough and Township of the same town", () => {
        // Expanding (not stripping) the suffix keeps them distinct.
        expect(muniKey("Hopewell Borough")).not.toBe(muniKey("Hopewell Township"))
        expect(muniKey("Hopewell Boro")).not.toBe(muniKey("Hopewell Twp"))
    })

    it("does not mangle 'boro'/'twp' embedded inside a name", () => {
        // e.g. Marlboro (Monmouth) — 'boro' isn't a standalone suffix here.
        expect(muniKey("Marlboro")).toBe("marlboro")
        expect(muniKey("Marlboro Twp")).toBe("marlboro township")
    })
})
