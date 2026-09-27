/** Road scopes (specs/road-model-v5.md § Span queries): a selected road can be viewed as one
 *  block, a stretch of blocks, the whole road (entity), or its corridor, and any exact chain range
 *  ("span") between two clicked points. Positions are *chain* miles: a continuous coordinate along
 *  an entity (`chain`), or along a corridor (`cchain = corridor_c0 + corridor_sign · chain`).
 *  Everything here is pure (no data fetching), for unit tests. */

const { abs, cos, max, min, PI, sqrt } = Math

export type ScopeLevel = "block" | "stretch" | "road" | "corridor"

/** Narrowest first: `[` / Alt+wheel-up steps left, `]` / Alt+wheel-down steps right. */
export const SCOPE_LEVELS: readonly ScopeLevel[] = ["block", "stretch", "road", "corridor"]

export const SCOPE_LABELS: Record<ScopeLevel, string> = {
    block: "Block",
    stretch: "Stretch",
    road: "Road",
    corridor: "Corridor",
}

/** A chain range, in miles (`lo` ≤ `hi`). */
export type Span = { lo: number; hi: number }

/** A stretch reaches this far (chain miles) either side of its centre, before snapping outward
 *  to block ends: ~½ mi total, several blocks on an urban street, one or two on a rural road. */
export const STRETCH_HALF_MI = 0.25

/** Chain positions within this of each other are the same point (the files' chain is float32,
 *  and URLs round to 3 decimals). */
const EPS = 0.0015

// ─── URL ────────────────────────────────────────────────────────────────────────────────────────

function fmt(x: number): string {
    return String(Number(x.toFixed(3)))
}

/** `span=<lo>-<hi>`, miles to 3 decimals (≈ 5 ft), e.g. `1.46-1.532`. */
export function encodeSpan({ lo, hi }: Span): string {
    return `${fmt(lo)}-${fmt(hi)}`
}

/** Inverse of `encodeSpan`; also accepts reversed ends. Null if malformed or empty. */
export function parseSpan(s: string | null | undefined): Span | null {
    const m = s?.match(/^(\d+(?:\.\d*)?)-(\d+(?:\.\d*)?)$/)
    if (!m) return null
    const a = Number(m[1]), b = Number(m[2])
    if (!isFinite(a) || !isFinite(b) || a === b) return null
    return { lo: min(a, b), hi: max(a, b) }
}

// ─── Blocks ─────────────────────────────────────────────────────────────────────────────────────

/** The `road-blocks` fields the ladder needs: sorted by `chain_lo`, contiguous (`chain_hi` of one
 *  = `chain_lo` of the next), covering `[0, chain_mi]`. */
export type BlockExtent = {
    block: number
    chain_lo: number
    chain_hi: number
    from_name?: string | null
    to_name?: string | null
}

/** Index of the block containing chain `c` (`[chain_lo, chain_hi)`, the last one closed), or of
 *  the nearest block when `c` is off the ends. -1 when there are no blocks. */
export function blockIndexAt(blocks: readonly BlockExtent[], c: number): number {
    if (!blocks.length) return -1
    if (c <= blocks[0].chain_lo) return 0
    for (let i = 0; i < blocks.length; i++) {
        if (c < blocks[i].chain_hi) return i
    }
    return blocks.length - 1
}

export function blockSpan(b: BlockExtent): Span {
    return { lo: b.chain_lo, hi: b.chain_hi }
}

/** Stretch around chain `c`: the contiguous run of blocks from the one containing `c - half` to
 *  the one containing `c + half`, i.e. `[c - half, c + half]` snapped outward to block ends. Always
 *  at least the block containing `c`; when that's the whole stretch (a long block) and the road has
 *  more, a neighbour on each side is added, so a stretch is always wider than a block. */
export function stretchAround(blocks: readonly BlockExtent[], c: number, half = STRETCH_HALF_MI): Span | null {
    const k = blockIndexAt(blocks, c)
    if (k < 0) return null
    // Nudged inward, so `c ± half` landing (within rounding) on a boundary doesn't pull in the
    // block beyond it.
    let i = min(k, blockIndexAt(blocks, c - half + EPS))
    let j = max(k, blockIndexAt(blocks, c + half - EPS))
    if (i === j) {
        i = max(0, i - 1)
        j = min(blocks.length - 1, j + 1)
    }
    return { lo: blocks[i].chain_lo, hi: blocks[j].chain_hi }
}

/** Whether `span` is exactly one block (within rounding). */
export function isBlockSpan(blocks: readonly BlockExtent[], span: Span): boolean {
    const k = blockIndexAt(blocks, (span.lo + span.hi) / 2)
    if (k < 0) return false
    const b = blocks[k]
    return abs(b.chain_lo - span.lo) < EPS && abs(b.chain_hi - span.hi) < EPS
}

/** `span` widened to whole blocks (the blocks it touches). */
export function snapToBlocks(blocks: readonly BlockExtent[], span: Span): Span {
    if (!blocks.length) return span
    const i = blockIndexAt(blocks, span.lo + EPS)
    const j = blockIndexAt(blocks, max(span.lo, span.hi - EPS))
    return { lo: blocks[i].chain_lo, hi: blocks[j].chain_hi }
}

/** Cross streets at a span's ends ("Communipaw Avenue", "Harrison Avenue"), from its blocks: the
 *  first touched block's `from_name` and the last's `to_name`, when the span starts / ends at them. */
export function spanEnds(blocks: readonly BlockExtent[], span: Span): { from: string | null; to: string | null } {
    if (!blocks.length) return { from: null, to: null }
    const i = blockIndexAt(blocks, span.lo + EPS)
    const j = blockIndexAt(blocks, max(span.lo, span.hi - EPS))
    const from = abs(blocks[i].chain_lo - span.lo) < EPS ? blocks[i].from_name ?? null : null
    const to = abs(blocks[j].chain_hi - span.hi) < EPS ? blocks[j].to_name ?? null : null
    return { from, to }
}

// ─── Ladder ─────────────────────────────────────────────────────────────────────────────────────

/** What the URL says about scope: a corridor flag, and an optional span (entity chain, or
 *  corridor chain with `corridor`). */
export type ScopeState = { corridor: boolean; span: Span | null }

export const ROAD_SCOPE: ScopeState = { corridor: false, span: null }

/** The ladder level of a scope state. A sub-road span is a "block" when it's exactly one block,
 *  else a "stretch" (including two-point spans, which `isCustomSpan` distinguishes). */
export function scopeLevel(state: ScopeState, blocks: readonly BlockExtent[]): ScopeLevel {
    if (state.corridor) return "corridor"
    if (!state.span) return "road"
    return isBlockSpan(blocks, state.span) ? "block" : "stretch"
}

/** A span that isn't the stretch or block around its own centre: two clicked points. */
export function isCustomSpan(state: ScopeState, blocks: readonly BlockExtent[]): boolean {
    const { span } = state
    if (!span || state.corridor) return !!span
    if (isBlockSpan(blocks, span)) return false
    const s = stretchAround(blocks, (span.lo + span.hi) / 2)
    return !s || abs(s.lo - span.lo) >= EPS || abs(s.hi - span.hi) >= EPS
}

/** The scope state for ladder `level`, centred on entity chain `anchor`. Null when the level isn't
 *  available (no blocks for sub-road levels; no corridor). */
export function scopeAt(
    level: ScopeLevel,
    anchor: number,
    blocks: readonly BlockExtent[],
    hasCorridor: boolean,
): ScopeState | null {
    switch (level) {
        case "road":
            return ROAD_SCOPE
        case "corridor":
            return hasCorridor ? { corridor: true, span: null } : null
        case "block": {
            const k = blockIndexAt(blocks, anchor)
            return k < 0 ? null : { corridor: false, span: blockSpan(blocks[k]) }
        }
        case "stretch": {
            const s = stretchAround(blocks, anchor)
            return s ? { corridor: false, span: s } : null
        }
    }
}

/** One step along the ladder from `state` (`dir` -1: narrower, +1: wider), centred on `anchor`.
 *  Steps past unavailable levels; returns `state` itself at either end. A two-point span steps
 *  to the level it's nearest in extent: narrower → the block at the anchor, wider → the road. */
export function stepScope(
    state: ScopeState,
    dir: -1 | 1,
    anchor: number,
    blocks: readonly BlockExtent[],
    hasCorridor: boolean,
): ScopeState {
    const cur = SCOPE_LEVELS.indexOf(scopeLevel(state, blocks))
    const custom = isCustomSpan(state, blocks)
    // A custom span sits between "stretch" and its neighbours: narrower from it is "stretch" at
    // the anchor, wider is "road".
    let k = custom && dir < 0 && !state.corridor ? cur : cur + dir
    // A corridor span's narrower step is the corridor itself.
    if (state.corridor && state.span && dir < 0) return { corridor: true, span: null }
    for (; k >= 0 && k < SCOPE_LEVELS.length; k += dir) {
        const next = scopeAt(SCOPE_LEVELS[k], anchor, blocks, hasCorridor)
        if (next) return next
    }
    return state
}

// ─── Corridors ──────────────────────────────────────────────────────────────────────────────────

/** A corridor member's mapping onto the corridor chain. */
export type CorridorMember = { entity: number; corridor_c0: number; corridor_sign: number; chain_mi: number }

export function toCorridorChain(m: Pick<CorridorMember, "corridor_c0" | "corridor_sign">, chain: number): number {
    return m.corridor_c0 + m.corridor_sign * chain
}

export function fromCorridorChain(m: Pick<CorridorMember, "corridor_c0" | "corridor_sign">, cchain: number): number {
    return m.corridor_sign < 0 ? m.corridor_c0 - cchain : cchain - m.corridor_c0
}

/** The member's own chain range covered by corridor span `span` (clipped to `[0, chain_mi]`), or
 *  null when the span misses it. */
export function memberSpan(m: CorridorMember, span: Span): Span | null {
    const a = fromCorridorChain(m, span.lo), b = fromCorridorChain(m, span.hi)
    const lo = max(0, min(a, b)), hi = min(m.chain_mi, max(a, b))
    return hi >= lo ? { lo, hi } : null
}

// ─── Geometry ───────────────────────────────────────────────────────────────────────────────────

/** An `sri-geom` point with its chain (v5). */
export type ChainPoint = { sri: string; mp: number; chain: number; lon: number; lat: number }

/** Same breaks as `roadPaths`: an MP gap > 0.15 or a jump > 400 m starts a new path. */
function joined(a: ChainPoint, b: ChainPoint): boolean {
    const dx = (b.lon - a.lon) * 111_320 * cos(a.lat * PI / 180)
    const dy = (b.lat - a.lat) * 110_540
    return b.mp - a.mp <= 0.15 && sqrt(dx * dx + dy * dy) <= 400
}

/** Consecutive-MP pairs of each SRI (both carriageways of a divided road are separate SRIs, which
 *  map to the same chain, so pairs never mix them). */
function segments(points: readonly ChainPoint[]): [ChainPoint, ChainPoint][] {
    const bySri = new Map<string, ChainPoint[]>()
    for (const p of points) {
        const list = bySri.get(p.sri)
        if (list) list.push(p)
        else bySri.set(p.sri, [p])
    }
    const out: [ChainPoint, ChainPoint][] = []
    for (const list of bySri.values()) {
        list.sort((x, y) => x.mp - y.mp)
        for (let i = 1; i < list.length; i++) {
            if (joined(list[i - 1], list[i])) out.push([list[i - 1], list[i]])
        }
    }
    return out
}

function lerp(a: ChainPoint, b: ChainPoint, t: number): [number, number] {
    return [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t]
}

/** The nearest position on the road to `[lon, lat]`, within `maxMeters`: its chain (interpolated
 *  along the nearest segment) and point. Null when nothing is that close. */
export function projectToChain(
    points: readonly ChainPoint[],
    [lon, lat]: [number, number],
    maxMeters: number,
): { chain: number; lngLat: [number, number]; meters: number } | null {
    const kx = 111_320 * cos(lat * PI / 180)
    const ky = 110_540
    let best: { chain: number; lngLat: [number, number]; meters: number } | null = null
    let bestD2 = maxMeters * maxMeters
    for (const [a, b] of segments(points)) {
        const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * ky
        const vx = (b.lon - a.lon) * kx, vy = (b.lat - a.lat) * ky
        const len2 = vx * vx + vy * vy
        const t = len2 > 0 ? max(0, min(1, -(ax * vx + ay * vy) / len2)) : 0
        const px = ax + t * vx, py = ay + t * vy
        const d2 = px * px + py * py
        if (d2 <= bestD2) {
            bestD2 = d2
            best = { chain: a.chain + (b.chain - a.chain) * t, lngLat: lerp(a, b, t), meters: sqrt(d2) }
        }
    }
    return best
}

/** The road's geometry within chain range `span`, as drawable paths: each segment clipped to the
 *  span (interpolating its cut ends), joined into runs. */
export function spanPaths(points: readonly ChainPoint[], { lo, hi }: Span): [number, number][][] {
    const out: [number, number][][] = []
    let cur: [number, number][] = []
    let prevB: ChainPoint | null = null
    const flush = () => {
        if (cur.length > 1) out.push(cur)
        cur = []
    }
    for (const [a, b] of segments(points)) {
        const c0 = min(a.chain, b.chain), c1 = max(a.chain, b.chain)
        if (c1 < lo || c0 > hi) { flush(); prevB = null; continue }
        const tAt = (c: number) => (b.chain === a.chain ? 0 : (c - a.chain) / (b.chain - a.chain))
        let t0 = max(0, min(1, tAt(lo))), t1 = max(0, min(1, tAt(hi)))
        if (t0 > t1) [t0, t1] = [t1, t0]
        const p0 = lerp(a, b, t0), p1 = lerp(a, b, t1)
        if (prevB !== a || t0 > 0) flush()
        if (!cur.length) cur.push(p0)
        cur.push(p1)
        prevB = t1 < 1 ? null : b
    }
    flush()
    return out
}

/** The point at entity chain `c` (nearest segment covering it), for span handles. */
export function pointAtChain(points: readonly ChainPoint[], c: number): [number, number] | null {
    for (const [a, b] of segments(points)) {
        const c0 = min(a.chain, b.chain), c1 = max(a.chain, b.chain)
        if (c >= c0 - 1e-6 && c <= c1 + 1e-6) {
            const t = b.chain === a.chain ? 0 : (c - a.chain) / (b.chain - a.chain)
            return lerp(a, b, max(0, min(1, t)))
        }
    }
    return null
}

// ─── Crash rows ─────────────────────────────────────────────────────────────────────────────────

/** Identity of a crash across `crashes-by-entity` / `-xs` rows: `id`, or the 4-field PK for rows
 *  without one (2024+). */
export function crashKey(c: { id: number | null; year: number; cc: number; mc: number; case: string }): string {
    return c.id !== null ? `#${c.id}` : `${c.year}/${c.cc}/${c.mc}/${c.case}`
}

/** Chain tolerance at span ends: crashes *at* an intersection sit exactly on a block boundary, up
 *  to float noise (the files' chain is float32, computed along different paths for crashes and
 *  blocks). */
export const END_TOL = 1e-4

/** Half-open `[lo, hi)` bounds for a span's placed crashes, with `END_TOL`: a crash at the
 *  intersection a span starts at is in it, one at the intersection it ends at belongs to the next
 *  block (as `road-blocks`), except at the road's end (`hiClosed`). */
export function spanBounds({ lo, hi }: Span, hiClosed: boolean): { min: number; max: number; maxInclusive: boolean } {
    return { min: lo - END_TOL, max: hiClosed ? hi + END_TOL : hi - END_TOL, maxInclusive: hiClosed }
}

/** `span` with ends within rounding (URLs keep 3 decimals) of a block boundary moved onto it. */
export function snapEnds(blocks: readonly BlockExtent[], span: Span): Span {
    const snap = (c: number) => {
        for (const b of blocks) {
            if (abs(b.chain_lo - c) < EPS) return b.chain_lo
            if (abs(b.chain_hi - c) < EPS) return b.chain_hi
        }
        return c
    }
    return { lo: snap(span.lo), hi: snap(span.hi) }
}

/** Placed crashes in `span` by `chain` (`spanBounds`; `hiClosed`: the span reaches the road's
 *  end), plus unplaced ones *pinned* to it (a cross street puts them within `[chain_lo,
 *  chain_hi]`, which overlaps the span). */
export function inSpan(
    c: { chain?: number | null; chain_lo?: number | null; chain_hi?: number | null },
    span: Span,
    hiClosed = true,
): boolean {
    const { lo, hi } = span
    if (c.chain !== null && c.chain !== undefined) {
        const b = spanBounds(span, hiClosed)
        return c.chain >= b.min && (b.maxInclusive ? c.chain <= b.max : c.chain < b.max)
    }
    if (c.chain_lo === null || c.chain_lo === undefined || c.chain_hi === null || c.chain_hi === undefined) return false
    return c.chain_lo <= hi && c.chain_hi >= lo
}

/** Whether a row is pinned (unplaced, but near a known intersection) rather than placed. */
export function isPinned(c: { chain?: number | null; chain_lo?: number | null }): boolean {
    return (c.chain === null || c.chain === undefined) && c.chain_lo !== null && c.chain_lo !== undefined
}

export type MonthRow = { year: number; month: number; severity: string; n: number; tk: number; ti: number; n_unplaced: number }

/** `road-summary-monthly`-shaped rows counted from crash rows (spans and corridors, which have no
 *  summary file cut to them); `unplaced(c)` says which count as "no map point". Sorted. */
export function summarizeCrashes<C extends { dt: number; severity: string; tk: number | null; ti: number | null }>(
    rows: readonly C[],
    unplaced: (c: C) => boolean,
): MonthRow[] {
    const cells = new Map<string, MonthRow>()
    for (const c of rows) {
        const d = new Date(c.dt)
        const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1
        const key = `${year}-${month}-${c.severity}`
        let r = cells.get(key)
        if (!r) cells.set(key, r = { year, month, severity: c.severity, n: 0, tk: 0, ti: 0, n_unplaced: 0 })
        r.n++
        r.tk += c.tk ?? 0
        r.ti += c.ti ?? 0
        if (unplaced(c)) r.n_unplaced++
    }
    return [...cells.values()].sort((a, b) => a.year - b.year || a.month - b.month || a.severity.localeCompare(b.severity))
}

/** Summary rows with other roads' intersection crashes added (`n + n_xs`, …): the inclusive view.
 *  Rows of builds without `n_xs` are unchanged. */
export function inclusiveSummary<R extends { n: number; tk: number; ti: number; n_xs?: number; tk_xs?: number; ti_xs?: number }>(rows: readonly R[]): R[] {
    return rows.map(r => ({ ...r, n: r.n + (r.n_xs ?? 0), tk: r.tk + (r.tk_xs ?? 0), ti: r.ti + (r.ti_xs ?? 0) }))
}

/** Crashes, fatal / injury crashes, and people killed (as `road-entities`' `n_*`). */
export type Totals = { n: number; fatal: number; injury: number; killed: number }

export const ZERO_TOTALS: Totals = { n: 0, fatal: 0, injury: 0, killed: 0 }

export function crashTotals(rows: readonly { severity: string; tk: number | null }[]): Totals {
    const t = { ...ZERO_TOTALS }
    for (const r of rows) {
        t.n++
        if (r.severity === "f") t.fatal++
        if (r.severity === "i") t.injury++
        t.killed += r.tk ?? 0
    }
    return t
}

export function addTotals(a: Totals, b: Totals | null): Totals {
    return b ? { n: a.n + b.n, fatal: a.fatal + b.fatal, injury: a.injury + b.injury, killed: a.killed + b.killed } : a
}
