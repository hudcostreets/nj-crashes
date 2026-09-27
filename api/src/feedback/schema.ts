/** Wire schema + validation for `POST /v1/feedback` reports.
 *
 *  The FE (`www/src/feedback/payload.ts`) builds the same shape; the two are
 *  kept in sync by hand (separate packages, no shared build). Everything in
 *  here is pure, so it's unit-tested directly (`schema.test.ts`). */

export const LIMITS = {
	comment: 5000,
	email: 254,
	url: 2048,
	ua: 512,
	theme: 16,
	buildSha: 64,
	tz: 64,
	actions: 100,
	actionLabel: 300,
	turnstileToken: 4096,
	/** Screenshot bytes (JPEG/WebP, downscaled client-side to ~1600px wide). */
	screenshot: 2_000_000,
	/** Whole multipart body: screenshot + JSON + multipart overhead. */
	body: 2_500_000,
} as const

export const ACTION_KINDS = ["nav", "param", "action", "click", "change"] as const
export type ActionKind = typeof ACTION_KINDS[number]

/** One entry of the client's recent-actions ring buffer. `t` is epoch ms. */
export type ActionEntry = {
	t: number
	kind: ActionKind
	label: string
}

export type ReportContext = {
	viewport: { w: number; h: number; dpr: number }
	ua: string
	/** User's theme setting (`light` / `dark` / `system`) and what it resolved to. */
	theme: string
	actualTheme: string
	buildSha: string | null
	tz: string | null
	/** Client clock at submit time (epoch ms); lets action times be shown relative. */
	ts: number
}

export type FeedbackReport = {
	v: 1
	comment: string
	email: string | null
	url: string
	context: ReportContext
	actions: ActionEntry[]
	turnstileToken: string | null
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

const isObj = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x)

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

/** Loose email check: one `@`, non-empty local part, a dot in the domain,
 *  no whitespace. Real validation is "did the reply bounce". */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function optStr(x: unknown, max: number, name: string): Validation<string | null> {
	if (x === undefined || x === null) return { ok: true, value: null }
	if (typeof x !== "string") return { ok: false, error: `${name} must be a string` }
	const s = x.trim()
	if (s.length > max) return { ok: false, error: `${name} too long (max ${max})` }
	return { ok: true, value: s || null }
}

/** Validate + normalize a parsed report JSON. Trims strings, maps empty
 *  optional strings to `null`, truncates action labels (a long label isn't
 *  worth rejecting a report over), and rejects anything structurally off. */
export function validateReport(raw: unknown): Validation<FeedbackReport> {
	if (!isObj(raw)) return { ok: false, error: "report must be an object" }
	if (raw.v !== 1) return { ok: false, error: "unsupported report version" }

	if (typeof raw.comment !== "string") return { ok: false, error: "comment required" }
	const comment = raw.comment.trim()
	if (!comment) return { ok: false, error: "comment required" }
	if (comment.length > LIMITS.comment) return { ok: false, error: `comment too long (max ${LIMITS.comment})` }

	const email = optStr(raw.email, LIMITS.email, "email")
	if (!email.ok) return email
	if (email.value !== null && !EMAIL_RE.test(email.value)) return { ok: false, error: "invalid email" }

	if (typeof raw.url !== "string" || !raw.url) return { ok: false, error: "url required" }
	if (raw.url.length > LIMITS.url) return { ok: false, error: `url too long (max ${LIMITS.url})` }
	let url: URL
	try {
		url = new URL(raw.url)
	} catch {
		return { ok: false, error: "invalid url" }
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "invalid url" }

	const c = raw.context
	if (!isObj(c)) return { ok: false, error: "context required" }
	const vp = c.viewport
	if (!isObj(vp) || !isFiniteNum(vp.w) || !isFiniteNum(vp.h) || !isFiniteNum(vp.dpr)) {
		return { ok: false, error: "context.viewport invalid" }
	}
	if (typeof c.ua !== "string") return { ok: false, error: "context.ua required" }
	if (typeof c.theme !== "string" || typeof c.actualTheme !== "string") return { ok: false, error: "context.theme required" }
	if (!isFiniteNum(c.ts)) return { ok: false, error: "context.ts required" }
	const buildSha = optStr(c.buildSha, LIMITS.buildSha, "context.buildSha")
	if (!buildSha.ok) return buildSha
	const tz = optStr(c.tz, LIMITS.tz, "context.tz")
	if (!tz.ok) return tz

	if (!Array.isArray(raw.actions)) return { ok: false, error: "actions must be an array" }
	if (raw.actions.length > LIMITS.actions) return { ok: false, error: `too many actions (max ${LIMITS.actions})` }
	const actions: ActionEntry[] = []
	for (const a of raw.actions) {
		if (!isObj(a) || !isFiniteNum(a.t) || typeof a.label !== "string" || !ACTION_KINDS.includes(a.kind as ActionKind)) {
			return { ok: false, error: "invalid action entry" }
		}
		actions.push({ t: a.t, kind: a.kind as ActionKind, label: a.label.slice(0, LIMITS.actionLabel) })
	}

	const turnstileToken = optStr(raw.turnstileToken, LIMITS.turnstileToken, "turnstileToken")
	if (!turnstileToken.ok) return turnstileToken

	return {
		ok: true,
		value: {
			v: 1,
			comment,
			email: email.value,
			url: raw.url,
			context: {
				viewport: { w: vp.w, h: vp.h, dpr: vp.dpr },
				ua: c.ua.slice(0, LIMITS.ua),
				theme: c.theme.slice(0, LIMITS.theme),
				actualTheme: c.actualTheme.slice(0, LIMITS.theme),
				buildSha: buildSha.value,
				tz: tz.value,
				ts: c.ts,
			},
			actions,
			turnstileToken: turnstileToken.value,
		},
	}
}

export type ImageType = "image/jpeg" | "image/webp" | "image/png"

export const IMAGE_EXT: Record<ImageType, string> = {
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/png": "png",
}

/** Identify an uploaded screenshot by its magic bytes (the multipart
 *  `Content-Type` is client-asserted). `null` = not an accepted image. */
export function sniffImageType(b: Uint8Array): ImageType | null {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
	if (
		b.length >= 8 &&
		b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
		b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
	) return "image/png"
	if (
		b.length >= 12 &&
		b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&  // RIFF
		b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50   // WEBP
	) return "image/webp"
	return null
}

/** Per-IP submission caps. Counts come from D1 (`feedback.ip_hash`). */
export const RATE_LIMITS = [
	{ windowSec: 10 * 60, max: 5 },
	{ windowSec: 24 * 60 * 60, max: 30 },
] as const

/** `null` = allowed; otherwise the `Retry-After` seconds of the tightest
 *  exceeded window. `counts[i]` pairs with `RATE_LIMITS[i]`. */
export function rateLimitVerdict(counts: readonly number[]): number | null {
	for (let i = 0; i < RATE_LIMITS.length; i++) {
		if ((counts[i] ?? 0) >= RATE_LIMITS[i].max) return RATE_LIMITS[i].windowSec
	}
	return null
}
