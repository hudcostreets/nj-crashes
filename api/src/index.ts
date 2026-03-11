/**
 * Crashes API — Cloudflare Worker with D1 bindings.
 *
 * Endpoints:
 *   GET /njdot/crashes?cc=&mc=&before=&limit=&offset=
 *   GET /njdot/crashes/count?cc=&mc=&before=
 *   GET /njdot/vehicles?crash_ids=1,2,3
 *   GET /njdot/occupants?crash_ids=1,2,3
 *   GET /njdot/pedestrians?crash_ids=1,2,3
 *   GET /njdot/year-stats?cc=&mc=
 *   GET /njdot/victim-severity?cc=&mc=
 *   GET /njsp/crashes?cc=&mc=&page=&limit=
 *   GET /njsp/crashes/count?cc=&mc=
 */

interface Env {
	CRASHES_DB: D1Database
	VEHICLES_DB: D1Database
	OCCUPANTS_DB: D1Database
	PEDESTRIANS_DB: D1Database
	CMYMC_DB: D1Database
	NJSP_CRASHES_DB: D1Database
	CORS_ORIGIN: string
}

function corsHeaders(env: Env): HeadersInit {
	return {
		"Access-Control-Allow-Origin": env.CORS_ORIGIN,
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Content-Type": "application/json",
	}
}

function intParam(url: URL, name: string): number | null {
	const v = url.searchParams.get(name)
	if (v === null) return null
	const n = parseInt(v, 10)
	return isNaN(n) ? null : n
}

function strParam(url: URL, name: string): string | null {
	return url.searchParams.get(name)
}

/** Build WHERE clause for NJDOT crashes (severity='i'|'f', optional cc/mc, dt filter). */
function njdotWhere(cc: number | null, mc: number | null, before: string | null): { clause: string; params: unknown[] } {
	const conditions: string[] = ["(severity = ?1 OR severity = ?2)"]
	const params: unknown[] = ["i", "f"]

	if (cc !== null) {
		params.push(cc)
		conditions.push(`cc = ?${params.length}`)
		if (mc !== null) {
			params.push(mc)
			conditions.push(`mc = ?${params.length}`)
		}
	}

	if (before) {
		params.push(before)
		conditions.push(`dt <= ?${params.length}`)
	}

	return { clause: conditions.join(" AND "), params }
}

/** Build WHERE clause for NJSP crashes (optional cc/mc). */
function njspWhere(cc: number | null, mc: number | null): { clause: string; params: unknown[] } {
	const conditions: string[] = []
	const params: unknown[] = []

	if (cc !== null) {
		params.push(cc)
		conditions.push(`cc = ?${params.length}`)
		if (mc !== null) {
			params.push(mc)
			conditions.push(`mc = ?${params.length}`)
		}
	}

	const clause = conditions.length ? conditions.join(" AND ") : "1=1"
	return { clause, params }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname

	// NJDOT crashes — paginated, filtered
	if (path === "/njdot/crashes") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const before = strParam(url, "before")
		const limit = intParam(url, "limit") ?? 10
		const offset = intParam(url, "offset") ?? 0
		const { clause, params } = njdotWhere(cc, mc, before)
		params.push(limit, offset)
		const sql = `SELECT * FROM crashes INDEXED BY dt_severity WHERE ${clause} ORDER BY dt DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
		const result = await env.CRASHES_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJDOT crashes count
	if (path === "/njdot/crashes/count") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const before = strParam(url, "before")
		const { clause, params } = njdotWhere(cc, mc, before)
		const sql = `SELECT count(*) as total FROM crashes WHERE ${clause}`
		const result = await env.CRASHES_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJDOT vehicles/occupants/pedestrians by crash_ids
	if (path === "/njdot/vehicles" || path === "/njdot/occupants" || path === "/njdot/pedestrians") {
		const idsStr = strParam(url, "crash_ids")
		if (!idsStr) {
			return Response.json({ error: "crash_ids required" }, { status: 400, headers: corsHeaders(env) })
		}
		const ids = idsStr.split(",").map(Number).filter(n => !isNaN(n))
		if (ids.length === 0) {
			return Response.json([], { headers: corsHeaders(env) })
		}
		const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ")
		const table = path.split("/").pop()!
		let columns: string
		if (table === "vehicles") {
			columns = "crash_id, damage, damage_loc, impact_loc, departure, type"
		} else if (table === "occupants") {
			columns = "crash_id, pos, condition, eject, age, sex, inj_loc, inj_type"
		} else {
			columns = "crash_id, condition, age, sex, inj_loc, inj_type, cyclist"
		}
		const db = table === "vehicles" ? env.VEHICLES_DB
			: table === "occupants" ? env.OCCUPANTS_DB
			: env.PEDESTRIANS_DB
		let extraWhere = ""
		let orderBy = ""
		if (table === "occupants") {
			extraWhere = " AND condition >= 1 AND condition < 5"
			orderBy = " ORDER BY crash_id, condition, pos"
		} else if (table === "pedestrians") {
			extraWhere = " AND condition >= 1 AND condition < 5"
			orderBy = " ORDER BY crash_id, condition, cyclist"
		}
		const sql = `SELECT ${columns} FROM ${table} WHERE crash_id IN (${placeholders})${extraWhere}${orderBy}`
		const result = await db.prepare(sql).bind(...ids).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJDOT year stats from cmymc.db
	if (path === "/njdot/year-stats") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const table = (cc ? "c" : "") + (mc ? "m" : "") + "yc"
		const conditions: string[] = []
		const params: unknown[] = []
		if (cc !== null) {
			params.push(cc)
			conditions.push(`cc = ?${params.length}`)
			if (mc !== null) {
				params.push(mc)
				conditions.push(`mc = ?${params.length}`)
			}
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
		const sql = `SELECT y, condition, drivers + passengers + pedestrians + cyclists as total, num_crashes FROM ${table} ${where} ORDER BY y DESC, condition ASC`
		const result = await env.CMYMC_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJDOT victim-severity breakdown from cmymc.db
	if (path === "/njdot/victim-severity") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const table = (cc ? "c" : "") + (mc ? "m" : "") + "yc"
		const conditions: string[] = []
		const params: unknown[] = []
		if (cc !== null) {
			params.push(cc)
			conditions.push(`cc = ?${params.length}`)
			if (mc !== null) {
				params.push(mc)
				conditions.push(`mc = ?${params.length}`)
			}
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
		const sql = `SELECT y, condition, drivers, passengers, pedestrians, cyclists, num_crashes FROM ${table} ${where} ORDER BY y ASC, condition ASC`
		const result = await env.CMYMC_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJSP crashes — paginated, filtered
	if (path === "/njsp/crashes") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const limit = intParam(url, "limit") ?? 10
		const offset = intParam(url, "offset") ?? 0
		const { clause, params } = njspWhere(cc, mc)
		params.push(limit, offset)
		const sql = `SELECT * FROM crashes WHERE ${clause} ORDER BY dt DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
		const result = await env.NJSP_CRASHES_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// NJSP crashes count
	if (path === "/njsp/crashes/count") {
		const cc = intParam(url, "cc")
		const mc = intParam(url, "mc")
		const { clause, params } = njspWhere(cc, mc)
		const sql = `SELECT count(*) as total FROM crashes WHERE ${clause}`
		const result = await env.NJSP_CRASHES_DB.prepare(sql).bind(...params).all()
		return Response.json(result.results, { headers: corsHeaders(env) })
	}

	// Status: report source MD5 and import timestamp for each database
	if (path === "/status") {
		const dbs: Record<string, D1Database> = {
			crashes: env.CRASHES_DB,
			vehicles: env.VEHICLES_DB,
			occupants: env.OCCUPANTS_DB,
			pedestrians: env.PEDESTRIANS_DB,
			cmymc: env.CMYMC_DB,
			"njsp-crashes": env.NJSP_CRASHES_DB,
		}
		const status: Record<string, unknown> = {}
		for (const [name, db] of Object.entries(dbs)) {
			try {
				const r = await db.prepare("SELECT * FROM _metadata LIMIT 1").first()
				status[name] = r ?? { error: "no _metadata table" }
			} catch {
				status[name] = { error: "no _metadata table" }
			}
		}
		return Response.json(status, { headers: corsHeaders(env) })
	}

	return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) })
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders(env) })
		}
		try {
			return await handleRequest(request, env)
		} catch (e) {
			const message = e instanceof Error ? e.message : "Internal error"
			return Response.json({ error: message }, { status: 500, headers: corsHeaders(env) })
		}
	},
}
