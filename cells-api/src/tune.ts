/** `/v1/tune/votes` — picker-tuning preference votes, backed by the
 *  `tune` D1 database (schema: `sql/tune.sql`).
 *
 *  Collected by the `/tune/ab` page: each row is one side-by-side verdict
 *  on an S2-level pair, with the picker features and measured per-side
 *  cost that a learner conditions on. See
 *  `specs/tune-preference-learning.md`.
 *
 *  Auth: reads are public (the corpus is not sensitive and the analysis
 *  wants to be shareable); writes require `Authorization: Bearer
 *  $TUNE_TOKEN`. Writes fail closed — no secret configured means no
 *  writes, rather than an open write endpoint. The `voter` column is the
 *  seam for $oa/auth logins later: token writes record NULL (the local
 *  admin), a logged-in voter would record their identity.
 */
import { HttpError } from "./cells"

/** Wire shape — camelCase, per-side objects; mirrors what `/tune/ab`
 *  builds. SQL columns are flat (see `sql/tune.sql`); this module is the
 *  only place the two shapes meet. */
export type VoteSide = {
    level: number
    bins: number | null
    bodyBytes: number | null
    wireBytes: number | null
    ms: number | null
}

export type Vote = {
    id?: number
    ts: string
    editedTs?: string | null
    voter?: string | null
    view: string
    lat: number
    lon: number
    zoom: number
    vp: [number, number]
    scopeKm2: number | null
    mppx: number
    areaPx: number
    autoTargetPx: number
    cfg: unknown
    prod: number
    left: VoteSide
    right: VoteSide
    choice: string
    chosen: number | null
    note: string
}

const CHOICES = ["left", "right", "tie", "finer", "coarser"]

/** Rows in the `picker_votes` table, as D1 returns them. */
type Row = Record<string, string | number | null>

function rowToVote(r: Row): Vote {
    const side = (p: "l" | "r"): VoteSide => ({
        level: r[`${p}_level`] as number,
        bins: r[`${p}_bins`] as number | null,
        bodyBytes: r[`${p}_body`] as number | null,
        wireBytes: r[`${p}_wire`] as number | null,
        ms: r[`${p}_ms`] as number | null,
    })
    return {
        id: r.id as number,
        ts: r.ts as string,
        editedTs: r.edited_ts as string | null,
        voter: r.voter as string | null,
        view: r.view as string,
        lat: r.lat as number,
        lon: r.lon as number,
        zoom: r.zoom as number,
        vp: [r.vp_w as number, r.vp_h as number],
        scopeKm2: r.scope_km2 as number | null,
        mppx: r.mppx as number,
        areaPx: r.area_px as number,
        autoTargetPx: r.auto_target_px as number,
        cfg: JSON.parse((r.cfg as string) || "{}"),
        prod: r.prod as number,
        left: side("l"),
        right: side("r"),
        choice: r.choice as string,
        chosen: r.chosen as number | null,
        note: (r.note as string) ?? "",
    }
}

function num(v: unknown, field: string): number {
    if (typeof v !== "number" || !isFinite(v)) throw new HttpError(400, `${field} must be a number`)
    return v
}

function optNum(v: unknown): number | null {
    return typeof v === "number" && isFinite(v) ? v : null
}

function side(v: unknown, field: string): VoteSide {
    if (typeof v !== "object" || v === null) throw new HttpError(400, `${field} must be an object`)
    const s = v as Record<string, unknown>
    return {
        level: num(s.level, `${field}.level`),
        bins: optNum(s.bins),
        bodyBytes: optNum(s.bodyBytes),
        wireBytes: optNum(s.wireBytes),
        ms: optNum(s.ms),
    }
}

/** Bearer-token gate for writes. Fails closed: an unset `TUNE_TOKEN`
 *  disables writing rather than opening it. */
export function requireWriteAuth(request: Request, token: string | undefined): void {
    if (!token) {
        throw new HttpError(503, "vote writes disabled: TUNE_TOKEN secret not configured")
    }
    const auth = request.headers.get("Authorization") ?? ""
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    // Constant-time-ish: compare full strings, not a prefix/early exit.
    if (supplied.length !== token.length || supplied !== token) {
        throw new HttpError(401, "bad or missing TUNE_TOKEN bearer credential")
    }
}

function requireDb(db: D1Database | undefined): D1Database {
    if (!db) throw new HttpError(503, "TUNE_DB binding not configured")
    return db
}

/** `GET /v1/tune/votes[?limit=N][&view=NAME]` → `{ votes: [...] }`,
 *  newest first. */
export async function listVotes(db: D1Database | undefined, url: URL): Promise<{ votes: Vote[] }> {
    const database = requireDb(db)
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "1000", 10)
    const limit = isNaN(limitRaw) ? 1000 : Math.max(1, Math.min(5000, limitRaw))
    const view = url.searchParams.get("view")
    const stmt = view
        ? database.prepare("SELECT * FROM picker_votes WHERE view = ? ORDER BY id DESC LIMIT ?").bind(view, limit)
        : database.prepare("SELECT * FROM picker_votes ORDER BY id DESC LIMIT ?").bind(limit)
    const { results } = await stmt.all<Row>()
    return { votes: (results ?? []).map(rowToVote) }
}

/** `POST /v1/tune/votes` → `{ ok, id }`. */
export async function insertVote(
    db: D1Database | undefined, body: unknown, voter: string | null,
): Promise<{ ok: true; id: number }> {
    const database = requireDb(db)
    if (typeof body !== "object" || body === null) throw new HttpError(400, "body must be an object")
    const b = body as Record<string, unknown>
    if (typeof b.view !== "string" || !b.view) throw new HttpError(400, "view required")
    if (typeof b.choice !== "string" || !CHOICES.includes(b.choice)) {
        throw new HttpError(400, `choice must be one of ${CHOICES.join(", ")}`)
    }
    const vp = Array.isArray(b.vp) ? b.vp : []
    if (vp.length !== 2) throw new HttpError(400, "vp must be [w, h]")
    const l = side(b.left, "left")
    const r = side(b.right, "right")
    const res = await database.prepare(`
        INSERT INTO picker_votes (
            ts, voter, view, lat, lon, zoom, vp_w, vp_h, scope_km2, mppx,
            area_px, auto_target_px, cfg, prod,
            l_level, l_bins, l_body, l_wire, l_ms,
            r_level, r_bins, r_body, r_wire, r_ms,
            choice, chosen, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
        typeof b.ts === "string" ? b.ts : new Date().toISOString(),
        voter,
        b.view,
        num(b.lat, "lat"), num(b.lon, "lon"), num(b.zoom, "zoom"),
        num(vp[0], "vp[0]"), num(vp[1], "vp[1]"),
        optNum(b.scopeKm2),
        num(b.mppx, "mppx"), num(b.areaPx, "areaPx"), num(b.autoTargetPx, "autoTargetPx"),
        JSON.stringify(b.cfg ?? {}),
        num(b.prod, "prod"),
        l.level, l.bins, l.bodyBytes, l.wireBytes, l.ms,
        r.level, r.bins, r.bodyBytes, r.wireBytes, r.ms,
        b.choice, optNum(b.chosen),
        typeof b.note === "string" ? b.note : "",
    ).run()
    return { ok: true, id: res.meta.last_row_id as number }
}

/** `PATCH /v1/tune/votes/:id` with `{ choice?, chosen?, note? }` →
 *  `{ ok }`. Stamps `edited_ts` so revised verdicts stay distinguishable
 *  from original ones in analysis. */
export async function updateVote(
    db: D1Database | undefined, id: number, body: unknown,
): Promise<{ ok: true }> {
    const database = requireDb(db)
    if (typeof body !== "object" || body === null) throw new HttpError(400, "body must be an object")
    const b = body as Record<string, unknown>
    const sets: string[] = []
    const args: (string | number | null)[] = []
    if (b.choice !== undefined) {
        if (typeof b.choice !== "string" || !CHOICES.includes(b.choice)) {
            throw new HttpError(400, `choice must be one of ${CHOICES.join(", ")}`)
        }
        sets.push("choice = ?")
        args.push(b.choice)
        // `chosen` is derived from `choice`, so it always travels with it.
        sets.push("chosen = ?")
        args.push(optNum(b.chosen))
    }
    if (b.note !== undefined) {
        if (typeof b.note !== "string") throw new HttpError(400, "note must be a string")
        sets.push("note = ?")
        args.push(b.note)
    }
    if (sets.length === 0) throw new HttpError(400, "nothing to update")
    sets.push("edited_ts = ?")
    args.push(new Date().toISOString())
    args.push(id)
    const res = await database.prepare(
        `UPDATE picker_votes SET ${sets.join(", ")} WHERE id = ?`,
    ).bind(...args).run()
    if (!res.meta.changes) throw new HttpError(404, `no vote with id ${id}`)
    return { ok: true }
}
