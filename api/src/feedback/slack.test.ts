import { describe, expect, it } from "vitest"
import type { FeedbackReport } from "./schema"
import { actionLines, relTime, slackMessage } from "./slack"

const report: FeedbackReport = {
	v: 1,
	comment: "Heatmap is empty <here>\nsecond line",
	email: "a@b.co",
	url: "https://crashes.hccs.dev/map?road=123",
	context: {
		viewport: { w: 1440, h: 900, dpr: 2 },
		ua: "Mozilla/5.0 (Macintosh)",
		theme: "system",
		actualTheme: "dark",
		buildSha: "257e8ecfb0d1234",
		tz: "America/New_York",
		ts: 100_000,
	},
	actions: [
		{ t: 40_000, kind: "nav", label: "/map" },
		{ t: 95_000, kind: "param", label: "road: ∅ → 123" },
		{ t: 99_000, kind: "click", label: "button `Heatmap`" },
	],
	turnstileToken: null,
}

describe("relTime", () => {
	it.each([
		[0, "-0s"],
		[12_400, "-12s"],
		[184_000, "-3m04s"],
		[3_725_000, "-1h02m"],
	])("%d → %s", (ms, want) => {
		expect(relTime(ms)).toBe(want)
	})
})

describe("actionLines", () => {
	it("renders the tail, oldest first, backticks neutralized", () => {
		expect(actionLines(report.actions, 100_000, 2)).toEqual([
			"    -5s  param   road: ∅ → 123",
			"    -1s  click   button 'Heatmap'",
		])
	})
})

describe("slackMessage", () => {
	it("renders all sections", () => {
		expect(slackMessage(report, { id: "abc", screenshotUrl: "https://api/x.jpg?t=1", country: "US" })).toEqual({
			text: "New site feedback from a@b.co: Heatmap is empty <here>\nsecond line",
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: "*New site feedback* from a@b.co\n>Heatmap is empty &lt;here&gt;\n>second line" } },
				{
					type: "section",
					fields: [
						{ type: "mrkdwn", text: "*Page*\n<https://crashes.hccs.dev/map?road=123|crashes.hccs.dev/map?road=123>" },
						{ type: "mrkdwn", text: "*Screenshot*\n<https://api/x.jpg?t=1|view>" },
					],
				},
				{ type: "context", elements: [{ type: "mrkdwn", text: "1440×900 @2x · theme dark (system) · build `257e8ecfb0d1234` · US" }] },
				{ type: "context", elements: [{ type: "mrkdwn", text: "Mozilla/5.0 (Macintosh)" }] },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Recent actions* (last 3 of 3)\n```\n -1m00s  nav     /map\n    -5s  param   road: ∅ → 123\n    -1s  click   button 'Heatmap'\n```",
					},
				},
				{ type: "context", elements: [{ type: "mrkdwn", text: "id `abc`" }] },
			],
		})
	})

	it("anonymous, no screenshot, no actions", () => {
		const msg = slackMessage(
			{ ...report, email: null, actions: [], context: { ...report.context, theme: "light", actualTheme: "light", buildSha: null } },
			{ id: "abc", screenshotUrl: null, country: null },
		)
		expect(msg.blocks).toEqual([
			{ type: "section", text: { type: "mrkdwn", text: "*New site feedback* from _anonymous_\n>Heatmap is empty &lt;here&gt;\n>second line" } },
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: "*Page*\n<https://crashes.hccs.dev/map?road=123|crashes.hccs.dev/map?road=123>" },
					{ type: "mrkdwn", text: "*Screenshot*\nnone" },
				],
			},
			{ type: "context", elements: [{ type: "mrkdwn", text: "1440×900 @2x · theme light · build ?" }] },
			{ type: "context", elements: [{ type: "mrkdwn", text: "Mozilla/5.0 (Macintosh)" }] },
			{ type: "context", elements: [{ type: "mrkdwn", text: "id `abc`" }] },
		])
	})
})
