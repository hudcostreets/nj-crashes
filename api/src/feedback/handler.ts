/** `/v1/feedback*` — user "report an issue" submissions.
 *
 *    GET  /v1/feedback/config                 public FE config (Turnstile site key, limits)
 *    POST /v1/feedback                        multipart: `report` (JSON) + optional `screenshot`
 *    GET  /v1/feedback?limit=&before=&full=   admin list (Bearer $FEEDBACK_ADMIN_TOKEN)
 *    GET  /v1/feedback/:id/screenshot?t=      screenshot, by per-report token (or admin Bearer)
 *
 *  Storage: D1 `crashes-feedback` (`FEEDBACK_DB`, schema `migrations/`),
 *  screenshots in the private R2 bucket `crashes-feedback` (`FEEDBACK_BUCKET`,
 *  no public domain — only reachable through the tokenized route above).
 *  Each report is also posted to Slack via `FEEDBACK_SLACK_WEBHOOK` when set.
 *
 *  None of these responses go through the edge cache (see `index.ts`). */
import {
	IMAGE_EXT,
	LIMITS,
	RATE_LIMITS,
	rateLimitVerdict,
	sniffImageType,
	validateReport,
	type FeedbackReport,
} from "./schema"
import { slackMessage } from "./slack"

export interface FeedbackEnv {
	FEEDBACK_DB?: D1Database
	FEEDBACK_BUCKET?: R2Bucket
	/** Secret. Slack incoming-webhook URL; unset → skip posting. */
	FEEDBACK_SLACK_WEBHOOK?: string
	/** Secret. Bearer token for the admin list; unset → list disabled. */
	FEEDBACK_ADMIN_TOKEN?: string
	/** Var (public). Turnstile site key served to the FE; unset → no widget. */
	TURNSTILE_SITE_KEY?: string
	/** Secret. Turnstile secret; set → every POST must carry a valid token. */
	TURNSTILE_SECRET?: string
}

type Headers = Record<string, string>

function json(body: unknown, status: number, headers: Headers): Response {
	return Response.json(body, { status, headers: { ...headers, "Cache-Control": "no-store" } })
}

function hex(buf: ArrayBuffer | Uint8Array): string {
	return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("")
}

async function sha256Hex(s: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))
}

function randomToken(): string {
	return hex(crypto.getRandomValues(new Uint8Array(16)))
}

function tokensEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a)
	const eb = new TextEncoder().encode(b)
	if (ea.length !== eb.length) return false
	return crypto.subtle.timingSafeEqual(ea, eb)
}

function isAdmin(request: Request, env: FeedbackEnv): boolean {
	const want = env.FEEDBACK_ADMIN_TOKEN
	if (!want) return false
	const got = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
	return tokensEqual(got, want)
}

async function verifyTurnstile(secret: string, token: string | null, ip: string | null): Promise<boolean> {
	if (!token) return false
	const form = new FormData()
	form.append("secret", secret)
	form.append("response", token)
	if (ip) form.append("remoteip", ip)
	const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
	if (!res.ok) return false
	const out = await res.json() as { success?: boolean; "error-codes"?: string[] }
	if (!out.success) console.warn("turnstile rejected:", out["error-codes"])
	return !!out.success
}

function screenshotUrl(origin: string, id: string, token: string): string {
	return `${origin}/v1/feedback/${id}/screenshot?t=${token}`
}

async function postSlack(webhook: string, body: unknown): Promise<string> {
	const res = await fetch(webhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
	if (res.ok) return "sent"
	const text = await res.text()
	console.error(`slack webhook ${res.status}: ${text.slice(0, 200)}`)
	return `error ${res.status}`
}

async function handlePost(request: Request, env: FeedbackEnv, ctx: ExecutionContext, headers: Headers): Promise<Response> {
	const db = env.FEEDBACK_DB
	if (!db) return json({ error: "feedback storage not configured" }, 503, headers)

	const len = Number(request.headers.get("Content-Length") ?? "0")
	if (len > LIMITS.body) return json({ error: "request too large" }, 413, headers)

	let form: FormData
	try {
		form = await request.formData()
	} catch {
		return json({ error: "expected multipart/form-data" }, 400, headers)
	}
	const rawReport = form.get("report")
	if (typeof rawReport !== "string") return json({ error: "missing report" }, 400, headers)
	let parsed: unknown
	try {
		parsed = JSON.parse(rawReport)
	} catch {
		return json({ error: "report is not JSON" }, 400, headers)
	}
	const v = validateReport(parsed)
	if (!v.ok) return json({ error: v.error }, 400, headers)
	const report: FeedbackReport = v.value

	// workers-types declares `FormData.get` as `string | null`; file parts are `File`s at runtime.
	const shot = form.get("screenshot") as unknown as File | string | null
	let shotBytes: Uint8Array | null = null
	if (shot !== null && typeof shot !== "string") {
		if (shot.size > LIMITS.screenshot) return json({ error: `screenshot too large (max ${LIMITS.screenshot} bytes)` }, 413, headers)
		shotBytes = new Uint8Array(await shot.arrayBuffer())
	}
	const shotType = shotBytes ? sniffImageType(shotBytes) : null
	if (shotBytes && !shotType) return json({ error: "screenshot must be JPEG, WebP, or PNG" }, 400, headers)

	const ip = request.headers.get("CF-Connecting-IP")
	const turnstileSecret = env.TURNSTILE_SECRET
	if (turnstileSecret) {
		if (!await verifyTurnstile(turnstileSecret, report.turnstileToken, ip)) {
			return json({ error: "verification failed, please retry" }, 403, headers)
		}
	}

	const ipHash = (await sha256Hex(`crashes-feedback:${ip ?? "unknown"}`)).slice(0, 32)
	const now = Date.now()
	const since = RATE_LIMITS.map(w => new Date(now - w.windowSec * 1000).toISOString())
	const counts = await db.prepare(
		"SELECT sum(created_at >= ?1) AS n0, count(*) AS n1 FROM feedback WHERE ip_hash = ?2 AND created_at >= ?3",
	).bind(since[0], ipHash, since[1]).first<{ n0: number | null; n1: number }>()
	const retryAfter = rateLimitVerdict([counts?.n0 ?? 0, counts?.n1 ?? 0])
	if (retryAfter !== null) {
		return json({ error: "too many reports, please try again later" }, 429, { ...headers, "Retry-After": String(retryAfter) })
	}

	const id = crypto.randomUUID()
	const token = randomToken()
	const createdAt = new Date(now).toISOString()
	let shotKey: string | null = null
	if (shotBytes && shotType) {
		const bucket = env.FEEDBACK_BUCKET
		if (!bucket) {
			console.warn("FEEDBACK_BUCKET unbound; dropping screenshot")
		} else {
			shotKey = `feedback/${createdAt.slice(0, 10)}/${id}.${IMAGE_EXT[shotType]}`
			await bucket.put(shotKey, shotBytes, { httpMetadata: { contentType: shotType } })
		}
	}

	let path = ""
	try {
		const u = new URL(report.url)
		path = `${u.pathname}${u.search}`
	} catch { /* validated already */ }
	const country = (request as { cf?: { country?: string } }).cf?.country ?? null
	const { context: c } = report
	await db.prepare(
		`INSERT INTO feedback (
			id, created_at, comment, email, url, path,
			vp_w, vp_h, dpr, ua, theme, actual_theme, build_sha, tz, client_ts,
			actions, screenshot_key, screenshot_type, screenshot_bytes, token,
			ip_hash, country, slack
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
	).bind(
		id, createdAt, report.comment, report.email, report.url, path,
		c.viewport.w, c.viewport.h, c.viewport.dpr, c.ua, c.theme, c.actualTheme, c.buildSha, c.tz, c.ts,
		JSON.stringify(report.actions), shotKey, shotKey ? shotType : null, shotKey ? shotBytes!.length : null, token,
		ipHash, country, null,
	).run()

	const origin = new URL(request.url).origin
	const webhook = env.FEEDBACK_SLACK_WEBHOOK
	if (webhook) {
		const msg = slackMessage(report, {
			id,
			screenshotUrl: shotKey ? screenshotUrl(origin, id, token) : null,
			country,
		})
		ctx.waitUntil(
			postSlack(webhook, msg)
				.catch(e => `error ${e instanceof Error ? e.message : String(e)}`)
				.then(status => db.prepare("UPDATE feedback SET slack = ?1 WHERE id = ?2").bind(status, id).run()),
		)
	} else {
		console.log(`feedback ${id}: FEEDBACK_SLACK_WEBHOOK unset, skipping Slack`)
		ctx.waitUntil(db.prepare("UPDATE feedback SET slack = 'skipped' WHERE id = ?1").bind(id).run())
	}

	return json({ id, screenshot: !!shotKey }, 201, headers)
}

type Row = Record<string, string | number | null>

async function handleList(request: Request, env: FeedbackEnv, headers: Headers): Promise<Response> {
	if (!env.FEEDBACK_ADMIN_TOKEN) return json({ error: "admin listing disabled (FEEDBACK_ADMIN_TOKEN unset)" }, 503, headers)
	if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401, headers)
	const db = env.FEEDBACK_DB
	if (!db) return json({ error: "feedback storage not configured" }, 503, headers)
	const url = new URL(request.url)
	const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 500)
	const before = url.searchParams.get("before")
	const full = url.searchParams.get("full") === "1"
	const cols = full ? "*" : "id, created_at, comment, email, url, vp_w, vp_h, dpr, theme, actual_theme, build_sha, screenshot_key, token, country, slack, status"
	const stmt = before
		? db.prepare(`SELECT ${cols} FROM feedback WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2`).bind(before, limit)
		: db.prepare(`SELECT ${cols} FROM feedback ORDER BY created_at DESC LIMIT ?1`).bind(limit)
	const { results } = await stmt.all<Row>()
	const origin = url.origin
	const rows = results.map(({ token, screenshot_key, actions, ip_hash: _ip, ...r }) => ({
		...r,
		...(full ? { actions: JSON.parse((actions as string) || "[]") } : {}),
		screenshotUrl: screenshot_key ? screenshotUrl(origin, r.id as string, token as string) : null,
	}))
	return json(rows, 200, headers)
}

async function handleScreenshot(request: Request, env: FeedbackEnv, id: string, headers: Headers): Promise<Response> {
	const db = env.FEEDBACK_DB
	const bucket = env.FEEDBACK_BUCKET
	if (!db || !bucket) return json({ error: "feedback storage not configured" }, 503, headers)
	const row = await db.prepare("SELECT token, screenshot_key FROM feedback WHERE id = ?1").bind(id).first<{ token: string; screenshot_key: string | null }>()
	const t = new URL(request.url).searchParams.get("t") ?? ""
	// Same 404 for "no such report" and "wrong token": don't confirm ids.
	if (!row || !row.screenshot_key || !(tokensEqual(t, row.token) || isAdmin(request, env))) {
		return json({ error: "not found" }, 404, headers)
	}
	const obj = await bucket.get(row.screenshot_key)
	if (!obj) return json({ error: "not found" }, 404, headers)
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "private, max-age=86400",
			"X-Robots-Tag": "noindex",
			"Referrer-Policy": "no-referrer",
		},
	})
}

/** `null` = not a feedback route (fall through to the data API). */
export async function handleFeedback(
	request: Request,
	env: FeedbackEnv,
	ctx: ExecutionContext,
	headers: Headers,
): Promise<Response | null> {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith("/v1/feedback")) return null
	if (pathname === "/v1/feedback/config" && request.method === "GET") {
		return json({
			turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
			limits: { comment: LIMITS.comment, email: LIMITS.email, screenshot: LIMITS.screenshot },
		}, 200, headers)
	}
	if (pathname === "/v1/feedback") {
		if (request.method === "POST") return handlePost(request, env, ctx, headers)
		if (request.method === "GET") return handleList(request, env, headers)
		return json({ error: "method not allowed" }, 405, headers)
	}
	const m = pathname.match(/^\/v1\/feedback\/([0-9a-f-]{36})\/screenshot$/)
	if (m && request.method === "GET") return handleScreenshot(request, env, m[1], headers)
	return json({ error: "Not found" }, 404, headers)
}
