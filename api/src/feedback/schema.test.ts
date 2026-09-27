import { describe, expect, it } from "vitest"
import { rateLimitVerdict, sniffImageType, validateReport, type FeedbackReport } from "./schema"

const base = {
	v: 1,
	comment: "  The road filter drops crashes on Rt 1  ",
	email: " someone@example.com ",
	url: "https://crashes.hccs.dev/map/middlesex?road=123&llz=40.4,-74.4,11",
	context: {
		viewport: { w: 1440, h: 900, dpr: 2 },
		ua: "Mozilla/5.0 (Macintosh)",
		theme: "system",
		actualTheme: "dark",
		buildSha: "257e8ecfb0d",
		tz: "America/New_York",
		ts: 1_790_000_000_000,
	},
	actions: [
		{ t: 1_789_999_990_000, kind: "nav", label: "/map/middlesex" },
		{ t: 1_789_999_995_000, kind: "param", label: "road: ∅ → 123" },
	],
	turnstileToken: "",
}

const expected: FeedbackReport = {
	v: 1,
	comment: "The road filter drops crashes on Rt 1",
	email: "someone@example.com",
	url: "https://crashes.hccs.dev/map/middlesex?road=123&llz=40.4,-74.4,11",
	context: {
		viewport: { w: 1440, h: 900, dpr: 2 },
		ua: "Mozilla/5.0 (Macintosh)",
		theme: "system",
		actualTheme: "dark",
		buildSha: "257e8ecfb0d",
		tz: "America/New_York",
		ts: 1_790_000_000_000,
	},
	actions: [
		{ t: 1_789_999_990_000, kind: "nav", label: "/map/middlesex" },
		{ t: 1_789_999_995_000, kind: "param", label: "road: ∅ → 123" },
	],
	turnstileToken: null,
}

describe("validateReport", () => {
	it("normalizes a valid report", () => {
		expect(validateReport(base)).toEqual({ ok: true, value: expected })
	})

	it("maps missing optional fields to null", () => {
		const { email: _e, turnstileToken: _t, ...rest } = base
		const r = validateReport({ ...rest, context: { ...base.context, buildSha: undefined, tz: null } })
		expect(r).toEqual({
			ok: true,
			value: { ...expected, email: null, turnstileToken: null, context: { ...expected.context, buildSha: null, tz: null } },
		})
	})

	it("truncates long action labels instead of rejecting", () => {
		const r = validateReport({ ...base, actions: [{ t: 1, kind: "click", label: "x".repeat(400) }] })
		expect(r).toEqual({ ok: true, value: { ...expected, actions: [{ t: 1, kind: "click", label: "x".repeat(300) }] } })
	})

	it.each([
		["non-object", null, "report must be an object"],
		["bad version", { ...base, v: 2 }, "unsupported report version"],
		["blank comment", { ...base, comment: "   " }, "comment required"],
		["long comment", { ...base, comment: "a".repeat(5001) }, "comment too long (max 5000)"],
		["bad email", { ...base, email: "not an email" }, "invalid email"],
		["non-http url", { ...base, url: "javascript:alert(1)" }, "invalid url"],
		["garbage url", { ...base, url: "::::" }, "invalid url"],
		["missing viewport", { ...base, context: { ...base.context, viewport: { w: 1 } } }, "context.viewport invalid"],
		["actions not array", { ...base, actions: {} }, "actions must be an array"],
		["too many actions", { ...base, actions: Array(101).fill(base.actions[0]) }, "too many actions (max 100)"],
		["unknown action kind", { ...base, actions: [{ t: 1, kind: "keylog", label: "a" }] }, "invalid action entry"],
	])("rejects %s", (_name, input, error) => {
		expect(validateReport(input)).toEqual({ ok: false, error })
	})
})

describe("sniffImageType", () => {
	const bytes = (...b: number[]) => new Uint8Array(b)
	it.each([
		["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
		["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"],
		["webp", bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50), "image/webp"],
		["riff non-webp", bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45), null],
		["html", new TextEncoder().encode("<html>"), null],
		["empty", bytes(), null],
	])("%s", (_name, input, want) => {
		expect(sniffImageType(input)).toBe(want)
	})
})

describe("rateLimitVerdict", () => {
	it.each([
		[[0, 0], null],
		[[4, 29], null],
		[[5, 5], 600],
		[[1, 30], 86400],
		[[9, 40], 600],
	])("%j → %s", (counts, want) => {
		expect(rateLimitVerdict(counts)).toBe(want)
	})
})
