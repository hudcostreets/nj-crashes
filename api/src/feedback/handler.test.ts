import { describe, expect, it, vi } from "vitest"
import { handleFeedback } from "./handler"
import { LIMITS } from "./schema"

describe("feedback request body limit", () => {
	it("parses bounded multipart bodies", async () => {
		const prepare = vi.fn()
		const env = { FEEDBACK_DB: { prepare } as unknown as D1Database }
		const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
		const form = new FormData()
		form.append("report", JSON.stringify({ v: 2 }))
		const request = new Request("https://crashes-api.hccs.dev/v1/feedback", { method: "POST", body: form })
		const response = await handleFeedback(request, env, ctx, {})
		expect({ status: response?.status, body: await response?.json() }).toEqual({
			status: 400,
			body: { error: "unsupported report version" },
		})
		expect(prepare.mock.calls).toEqual([])
	})
	it.each([undefined, "0", "1"])("rejects an oversized body with Content-Length %s", async contentLength => {
		const prepare = vi.fn()
		const env = { FEEDBACK_DB: { prepare } as unknown as D1Database }
		const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
		const headers = new Headers()
		if (contentLength !== undefined) headers.set("Content-Length", contentLength)
		const request = new Request("https://crashes-api.hccs.dev/v1/feedback", {
			method: "POST",
			headers,
			body: new Uint8Array(LIMITS.body + 1),
		})
		const response = await handleFeedback(request, env, ctx, {})
		expect({ status: response?.status, body: await response?.json() }).toEqual({
			status: 413,
			body: { error: "request too large" },
		})
		expect(prepare.mock.calls).toEqual([])
	})
})
