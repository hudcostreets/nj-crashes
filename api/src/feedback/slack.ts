/** Slack incoming-webhook message for a new feedback report. Pure (the
 *  POST lives in `handler.ts`), so the rendered shape is unit-tested. */
import type { ActionEntry, FeedbackReport } from "./schema"

export type SlackMeta = {
	id: string
	/** Tokenized worker URL for the screenshot, or `null` when none was attached. */
	screenshotUrl: string | null
	/** `request.cf.country` of the submitter, if known. */
	country: string | null
}

export type SlackMessage = {
	text: string
	blocks: unknown[]
}

/** Slack mrkdwn control chars; everything user-supplied goes through this. */
export function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export const SLACK_ACTIONS_TAIL = 12
const COMMENT_MAX = 2800  // section text cap is 3000

/** `-12s`, `-3m04s`, `-1h02m` relative to submit time. */
export function relTime(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `-${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `-${m}m${String(s % 60).padStart(2, "0")}s`
	return `-${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

/** Last `n` actions as fixed-width lines, oldest first. Backticks are
 *  swapped out so a label can't close the code block. */
export function actionLines(actions: ActionEntry[], now: number, n = SLACK_ACTIONS_TAIL): string[] {
	return actions.slice(-n).map(a =>
		`${relTime(now - a.t).padStart(7)}  ${a.kind.padEnd(6)}  ${a.label.replace(/`/g, "'")}`,
	)
}

function pageLabel(url: string): string {
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname}${u.search}`
	} catch {
		return url
	}
}

export function slackMessage(r: FeedbackReport, meta: SlackMeta): SlackMessage {
	const { context: c } = r
	const comment = r.comment.length > COMMENT_MAX ? `${r.comment.slice(0, COMMENT_MAX)}…` : r.comment
	const quoted = esc(comment).split("\n").map(l => `>${l}`).join("\n")
	const from = r.email ? esc(r.email) : "_anonymous_"
	const page = `<${esc(r.url)}|${esc(pageLabel(r.url))}>`
	const env = [
		`${c.viewport.w}×${c.viewport.h} @${c.viewport.dpr}x`,
		`theme ${esc(c.actualTheme)}${c.theme === "system" ? " (system)" : ""}`,
		c.buildSha ? `build \`${esc(c.buildSha)}\`` : "build ?",
		...(meta.country ? [esc(meta.country)] : []),
	].join(" · ")
	const lines = actionLines(r.actions, c.ts)
	const blocks: unknown[] = [
		{ type: "section", text: { type: "mrkdwn", text: `*New site feedback* from ${from}\n${quoted}` } },
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Page*\n${page}` },
				{ type: "mrkdwn", text: `*Screenshot*\n${meta.screenshotUrl ? `<${meta.screenshotUrl}|view>` : "none"}` },
			],
		},
		{ type: "context", elements: [{ type: "mrkdwn", text: env }] },
		{ type: "context", elements: [{ type: "mrkdwn", text: esc(c.ua) }] },
	]
	if (lines.length) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Recent actions* (last ${lines.length} of ${r.actions.length})\n\`\`\`\n${esc(lines.join("\n"))}\n\`\`\``,
			},
		})
	}
	blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `id \`${meta.id}\`` }] })
	return {
		text: `New site feedback from ${r.email ?? "anonymous"}: ${comment.slice(0, 200)}`,
		blocks,
	}
}
