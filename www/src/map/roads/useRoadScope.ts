/** A selected road's *scope* (block → stretch → road → corridor, or a two-point span) and
 *  exclusive / inclusive view: URL state, data, stats and highlight geometry (specs/road-model-v5.md
 *  § Span queries). Shared by the map (`useRoadSelection`) and the road page.
 *
 *  URL: `span=<lo>-<hi>` (chain miles on the road, or on its corridor with `cor`), `cor` (corridor
 *  scope), `xs=0` (exclusive: only crashes on this road; default inclusive: crashes at its
 *  intersections that police put on the cross street count too). */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { boolParam, stringParam, useUrlState, type Param } from "use-prms"
import { useDb } from "@/src/lib/DuckDbContext"
import { useAction } from "@/src/lib/kbd"
import {
    fetchBlocks, fetchCorridor, fetchEntity, fetchEntityCrashes, fetchEntityGeom, fetchEntityNames, fetchEntityXs,
    fetchSpanCrashes, isUnplaced, isV5, type RoadCorridor, type RoadCrashView, type RoadEntity, type RoadPoint,
    type RoadSummaryRow,
} from "./roadsData"
import {
    crashKey, crashTotals, encodeSpan, inclusiveSummary, inSpan, isCustomSpan, isPinned, memberSpan, parseSpan, snapEnds,
    pointAtChain, projectToChain, ROAD_SCOPE, SCOPE_LEVELS, scopeAt, scopeLevel, spanEnds, spanPaths, stepScope,
    summarizeCrashes, toCorridorChain, type ChainPoint, type CorridorMember, type ScopeLevel, type ScopeState, type Span,
    type Totals,
} from "./roadScope"

/** `xs`: inclusive by default (absent); `xs=0` → exclusive. */
const inclusiveParam: Param<boolean> = {
    encode: v => (v ? undefined : "0"),
    decode: s => s !== "0",
}

/** A crash row in a scope's list: `own_name` names the road it's on, for rows counted here at an
 *  intersection (`crashes-by-entity-xs`). */
export type ScopeCrash = RoadCrashView & { own_name?: string | null }

export type ScopeCounts = {
    /** Crashes on this road (or corridor) in scope. */
    own: Totals
    /** Other roads' crashes at its intersections in scope (null: not available, v4). */
    xs: Totals | null
}

type GeomPoint = RoadPoint & { chain?: number }

function chainPoints(points: GeomPoint[] | undefined): ChainPoint[] {
    return (points ?? []).filter((p): p is GeomPoint & { chain: number } => typeof p.chain === "number")
}

function entityTotals(e: RoadEntity): ScopeCounts {
    return {
        own: { n: e.n_crashes, fatal: e.n_fatal, injury: e.n_injury, killed: e.n_killed },
        xs: typeof e.n_crashes_xs === "number"
            ? { n: e.n_crashes_xs, fatal: e.n_fatal_xs ?? 0, injury: e.n_injury_xs ?? 0, killed: e.n_killed_xs ?? 0 }
            : null,
    }
}

function corridorTotals(c: RoadCorridor): ScopeCounts {
    return {
        own: { n: c.n_crashes, fatal: c.n_fatal, injury: c.n_injury, killed: c.n_killed },
        xs: { n: c.n_crashes_xs, fatal: c.n_fatal_xs, injury: c.n_injury_xs, killed: c.n_killed_xs },
    }
}

function members(c: RoadCorridor | null | undefined): number[] {
    return c ? c.entities.split(",").map(Number).filter(n => Number.isInteger(n)) : []
}

export type UseRoadScopeArgs = {
    /** The selected road (null while loading). */
    info: RoadEntity | null
    /** Its `sri-geom` points (with `chain` on v5). */
    geom: GeomPoint[] | null
    /** Its `road-summary` or `road-summary-monthly` rows (the whole road, exclusive + `n_xs`). */
    roadSummary: RoadSummaryRow[] | null
    /** Register the `[` / `]` hotkeys (one consumer at a time). */
    hotkeys?: boolean
}

export function useRoadScope({ info, geom, roadSummary, hotkeys = false }: UseRoadScopeArgs) {
    const db = useDb()
    const qc = useQueryClient()
    const [spanUrl, setSpanUrl] = useUrlState("span", stringParam())
    const [corUrl, setCorUrl] = useUrlState("cor", boolParam)
    const [inclusiveUrl, setInclusive] = useUrlState("xs", inclusiveParam)
    const v5 = isV5(info)
    const entity = info?.entity ?? null
    const inclusive = v5 && inclusiveUrl

    const corridorId = v5 && info?.corridor !== null && info?.corridor !== undefined ? info.corridor : null
    const blocksQ = useQuery({
        queryKey: ["road-blocks", entity],
        queryFn: () => fetchBlocks(db!, entity!),
        enabled: !!db && v5 && entity !== null,
        staleTime: Infinity,
    })
    const blocks = useMemo(() => blocksQ.data ?? [], [blocksQ.data])
    // A road span's ends are snapped onto the block boundaries they round (URLs keep 3 decimals),
    // so "at the intersection" crashes fall on the right side; its crashes load after its blocks.
    const state: ScopeState = useMemo(() => {
        if (!v5) return ROAD_SCOPE
        const corridor = !!corUrl && corridorId !== null
        const span = parseSpan(spanUrl)
        return { corridor, span: span && !corridor ? snapEnds(blocks, span) : span }
    }, [v5, spanUrl, corUrl, corridorId, blocks])
    const setState = useCallback((s: ScopeState) => {
        setCorUrl(s.corridor)
        setSpanUrl(s.span ? encodeSpan(s.span) : undefined)
    }, [setCorUrl, setSpanUrl])
    const clear = useCallback(() => setState(ROAD_SCOPE), [setState])
    const corridorQ = useQuery({
        queryKey: ["road-corridor", corridorId],
        queryFn: () => fetchCorridor(db!, corridorId!),
        enabled: !!db && corridorId !== null,
        staleTime: Infinity,
    })
    const corridor = corridorQ.data ?? null
    const memberIds = useMemo(() => (state.corridor ? members(corridor) : []), [state.corridor, corridor])
    const memberInfos = useQueries({
        queries: memberIds.map(id => ({
            queryKey: ["road-entity", id],
            queryFn: () => fetchEntity(db!, id),
            enabled: !!db,
            staleTime: Infinity,
        })),
    })
    const memberGeoms = useQueries({
        queries: memberIds.map(id => ({
            queryKey: ["road-geom", id],
            queryFn: () => fetchEntityGeom(db!, id),
            enabled: !!db,
            staleTime: Infinity,
        })),
    })
    const corridorMembers = useMemo((): (CorridorMember & { points: ChainPoint[]; name: string })[] => memberIds.flatMap((id, k) => {
        const e = memberInfos[k]?.data
        if (!e || e.corridor_c0 === null || e.corridor_c0 === undefined || !e.corridor_sign || typeof e.chain_mi !== "number") return []
        return [{
            entity: id, corridor_c0: e.corridor_c0, corridor_sign: e.corridor_sign, chain_mi: e.chain_mi, name: e.name,
            points: chainPoints(memberGeoms[k]?.data),
        }]
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [memberIds, ...memberInfos.map(q => q.data), ...memberGeoms.map(q => q.data)])

    const points = useMemo(() => chainPoints(geom ?? undefined), [geom])
    const level: ScopeLevel = scopeLevel(state, blocks)
    const custom = isCustomSpan(state, blocks)

    // The anchor: where the ladder centres (a clicked point, else the span's centre, else the road's
    // middle), in the road's chain; `canchor` the same on the corridor chain.
    const [anchor, setAnchor] = useState<number | null>(null)
    const [canchor, setCanchor] = useState<number | null>(null)
    useEffect(() => { setAnchor(null); setCanchor(null) }, [entity])
    // A click that selected the road: anchored where it landed, once the road's geometry is in.
    const [pending, setPending] = useState<{ entity: number; lngLat: [number, number] } | null>(null)
    useEffect(() => {
        if (!pending || pending.entity !== entity || !points.length) return
        const hit = projectToChain(points, pending.lngLat, 500)
        if (hit) setAnchor(hit.chain)
        setPending(null)
    }, [pending, entity, points])
    /** Anchor road `e` (just selected by a click at `lngLat`) at that point once it loads. */
    const anchorOnLoad = useCallback((e: number, lngLat: [number, number]) => setPending({ entity: e, lngLat }), [])
    const spanMid = state.span && !state.corridor ? (state.span.lo + state.span.hi) / 2 : null
    const anchorChain = anchor ?? spanMid ?? (info?.chain_mi ?? 0) / 2
    const selfMember = corridorMembers.find(m => m.entity === entity)
    const canchorChain = canchor ?? (selfMember ? toCorridorChain(selfMember, anchorChain) : null)

    const step = useCallback((dir: -1 | 1) => {
        if (!v5) return
        // Keep the centre across steps (a road-scope step up would otherwise lose the span's).
        setAnchor(anchorChain)
        setState(stepScope(state, dir, anchorChain, blocks, corridorId !== null))
    }, [v5, state, anchorChain, blocks, corridorId, setState])
    const toLevel = useCallback((l: ScopeLevel) => {
        const s = scopeAt(l, anchorChain, blocks, corridorId !== null)
        setAnchor(anchorChain)
        if (s) setState(s)
    }, [anchorChain, blocks, corridorId, setState])
    const available = useMemo(
        () => SCOPE_LEVELS.filter(l => v5 && scopeAt(l, anchorChain, blocks, corridorId !== null) !== null),
        [v5, anchorChain, blocks, corridorId],
    )

    /** A click at `lngLat` on the selected road (or, in corridor scope, any member): moves the
     *  anchor there (block / stretch scopes follow it); with `extend` (shift-click), selects the
     *  exact span from the anchor to it. Returns false when the click isn't on it. */
    const onRoadClick = useCallback((lngLat: [number, number], extend: boolean, maxMeters: number): boolean => {
        if (!v5) return false
        if (state.corridor) {
            let best: { m: typeof corridorMembers[number]; chain: number; meters: number } | null = null
            for (const m of corridorMembers) {
                const hit = projectToChain(m.points, lngLat, maxMeters)
                if (hit && (!best || hit.meters < best.meters)) best = { m, chain: hit.chain, meters: hit.meters }
            }
            if (!best) return false
            const c = toCorridorChain(best.m, best.chain)
            if (best.m.entity === entity) setAnchor(best.chain)
            if (extend && canchorChain !== null && Math.abs(c - canchorChain) > 0.001) {
                setState({ corridor: true, span: { lo: Math.min(c, canchorChain), hi: Math.max(c, canchorChain) } })
            } else {
                setCanchor(c)
            }
            return true
        }
        const hit = projectToChain(points, lngLat, maxMeters)
        if (!hit) return false
        const c = hit.chain
        if (extend) {
            const a = anchor ?? spanMid
            if (a !== null && Math.abs(c - a) > 0.001) {
                setState({ corridor: false, span: { lo: Math.min(a, c), hi: Math.max(a, c) } })
                return true
            }
        }
        setAnchor(c)
        if (!custom && (level === "block" || level === "stretch")) {
            const s = scopeAt(level, c, blocks, corridorId !== null)
            if (s) setState(s)
        }
        return true
    }, [v5, state.corridor, corridorMembers, entity, canchorChain, points, anchor, spanMid, custom, level, blocks, corridorId, setState])

    // A span being dragged by an end handle: drawn live, committed to the URL (and its crashes
    // loaded) on release.
    const [dragSpan, setDragSpan] = useState<Span | null>(null)
    /** Drag a span end to `lngLat` (end handles): `end` 0 = lo, 1 = hi; `commit` on release. The
     *  other end stays where it was when the drag started. */
    const dragEnd = useCallback((end: 0 | 1, lngLat: [number, number] | null, maxMeters: number, commit: boolean) => {
        const span = state.span
        if (!span) return
        if (!lngLat) {
            if (commit && dragSpan) setState({ corridor: state.corridor, span: dragSpan })
            if (commit) setDragSpan(null)
            return
        }
        let c: number | null = null
        if (state.corridor) {
            let best: { c: number; meters: number } | null = null
            for (const m of corridorMembers) {
                const hit = projectToChain(m.points, lngLat, maxMeters)
                if (hit && (!best || hit.meters < best.meters)) best = { c: toCorridorChain(m, hit.chain), meters: hit.meters }
            }
            c = best?.c ?? null
        } else {
            c = projectToChain(points, lngLat, maxMeters)?.chain ?? null
        }
        const other = end === 0 ? span.hi : span.lo
        const next = c !== null && Math.abs(c - other) >= 0.005
            ? { lo: Math.min(c, other), hi: Math.max(c, other) }
            : dragSpan
        if (commit) {
            if (next) setState({ corridor: state.corridor, span: next })
            setDragSpan(null)
        } else if (next) {
            setDragSpan(next)
        }
    }, [state, corridorMembers, points, setState, dragSpan])

    // ─── Crashes ────────────────────────────────────────────────────────────────────────────────
    const span = state.span
    const entitySpan = !state.corridor ? span : null
    const hiClosed = !!entitySpan && typeof info?.chain_mi === "number" && entitySpan.hi >= info.chain_mi - 0.0015
    const blocksReady = blocksQ.isSuccess
    const wholeKey = ["road-crashes", entity]
    const whole = useQuery({
        queryKey: wholeKey,
        queryFn: () => fetchEntityCrashes(db!, entity!, v5),
        enabled: !!db && entity !== null && !state.corridor && !entitySpan,
        staleTime: Infinity,
    })
    // A span reads its own rows (~1 row group), or filters the whole road's when they're cached.
    const spanQ = useQuery({
        queryKey: ["road-span-crashes", entity, entitySpan?.lo, entitySpan?.hi],
        queryFn: () => {
            const all = qc.getQueryData<RoadCrashView[]>(wholeKey)
            return all ? all.filter(c => inSpan(c, entitySpan!, hiClosed)) : fetchSpanCrashes(db!, entity!, entitySpan!, hiClosed)
        },
        enabled: !!db && entity !== null && !!entitySpan && blocksReady,
        staleTime: Infinity,
    })
    const xsWholeKey = ["road-xs", entity]
    const xsWhole = useQuery({
        queryKey: xsWholeKey,
        queryFn: () => fetchEntityXs(db!, entity!),
        enabled: !!db && entity !== null && inclusive && !state.corridor && !entitySpan,
        staleTime: Infinity,
    })
    const xsSpan = useQuery({
        queryKey: ["road-xs-span", entity, entitySpan?.lo, entitySpan?.hi],
        queryFn: () => {
            const all = qc.getQueryData<RoadCrashView[]>(xsWholeKey)
            return all ? all.filter(c => inSpan(c, entitySpan!, hiClosed)) : fetchEntityXs(db!, entity!, entitySpan!, hiClosed)
        },
        enabled: !!db && entity !== null && v5 && !!entitySpan && blocksReady,
        staleTime: Infinity,
    })
    // Corridor: each member's whole list (one `entity = ?` read each), filtered to the span.
    const memberCrashes = useQueries({
        queries: memberIds.map(id => ({
            queryKey: ["road-crashes", id],
            queryFn: () => fetchEntityCrashes(db!, id, true),
            enabled: !!db,
            staleTime: Infinity,
        })),
    })
    const memberXs = useQueries({
        queries: (inclusive ? memberIds : []).map(id => ({
            queryKey: ["road-xs", id],
            queryFn: () => fetchEntityXs(db!, id),
            enabled: !!db,
            staleTime: Infinity,
        })),
    })

    const { rows: rawRows, loading: rowsLoading } = useMemo((): { rows: RoadCrashView[] | null; loading: boolean } => {
        if (state.corridor) {
            if (!corridorMembers.length || memberCrashes.some(q => !q.data) || memberXs.some(q => !q.data)) {
                return { rows: null, loading: true }
            }
            const ids = new Set(memberIds)
            const byId = new Map(corridorMembers.map(m => [m.entity, m]))
            const keep = (c: RoadCrashView, m: CorridorMember | undefined) => {
                if (!span) return true
                if (!m) return false
                const ms = memberSpan(m, span)
                return !!ms && inSpan(c, ms, ms.hi >= m.chain_mi - 0.0015)
            }
            const seen = new Set<string>()
            const out: RoadCrashView[] = []
            memberIds.forEach((id, k) => {
                for (const c of memberCrashes[k].data!) if (keep(c, byId.get(id))) { seen.add(crashKey(c)); out.push(c) }
            })
            memberIds.forEach((id, k) => {
                for (const c of memberXs[k]?.data ?? []) {
                    // Crashes on a member are already counted; one at two members' intersection once.
                    if (c.own_entity !== null && c.own_entity !== undefined && ids.has(c.own_entity)) continue
                    const key = crashKey(c)
                    if (seen.has(key) || !keep(c, byId.get(id))) continue
                    seen.add(key)
                    out.push(c)
                }
            })
            return { rows: out, loading: false }
        }
        const own = entitySpan ? spanQ.data : whole.data
        const xs = inclusive ? (entitySpan ? xsSpan.data : xsWhole.data) : []
        if (!own || !xs) return { rows: own ?? null, loading: true }
        return { rows: xs.length ? [...own, ...xs] : own, loading: false }
    }, [
        state.corridor, corridorMembers, memberCrashes, memberXs, memberIds, span, entitySpan, spanQ.data, whole.data,
        inclusive, xsSpan.data, xsWhole.data,
    ])

    // Names of the roads xs rows are on.
    const ownIds = useMemo(() => {
        const s = new Set<number>()
        for (const c of rawRows ?? []) if (c.own_entity !== null && c.own_entity !== undefined) s.add(c.own_entity)
        return [...s].sort((a, b) => a - b)
    }, [rawRows])
    const names = useQuery({
        queryKey: ["road-names", ownIds.join(",")],
        queryFn: () => fetchEntityNames(db!, ownIds),
        enabled: !!db && ownIds.length > 0,
        staleTime: Infinity,
    })
    const crashes = useMemo((): ScopeCrash[] | null => {
        if (!rawRows) return null
        const withNames = ownIds.length
            ? rawRows.map(c => (c.own_entity !== null && c.own_entity !== undefined ? { ...c, own_name: names.data?.get(c.own_entity) ?? null } : c))
            : rawRows
        // Along the road: by chain (corridor chain in corridor scope), unplaced last, then date.
        if (!v5) return withNames
        const byId = new Map(corridorMembers.map(m => [m.entity, m]))
        const pos = (c: RoadCrashView): number | null => {
            const ch = c.chain ?? (isPinned(c) ? ((c.chain_lo ?? 0) + (c.chain_hi ?? 0)) / 2 : null)
            if (ch === null) return null
            if (!state.corridor) return ch
            const m = c.entity !== undefined ? byId.get(c.entity) : undefined
            return m ? toCorridorChain(m, ch) : ch
        }
        const keyed = withNames.map(c => ({ c, p: pos(c) }))
        keyed.sort((a, b) => (a.p === null ? 1 : 0) - (b.p === null ? 1 : 0) || (a.p ?? 0) - (b.p ?? 0) || a.c.dt - b.c.dt)
        return keyed.map(k => k.c)
    }, [rawRows, ownIds, names.data, v5, corridorMembers, state.corridor])

    /** A row's position for display: its chain, on the corridor's chain in corridor scope. */
    const displayChain = useCallback((c: RoadCrashView): number | null => {
        if (c.chain === null || c.chain === undefined) return null
        if (!state.corridor) return c.chain
        const m = corridorMembers.find(m => m.entity === c.entity)
        return m ? toCorridorChain(m, c.chain) : c.chain
    }, [state.corridor, corridorMembers])

    // ─── Stats ──────────────────────────────────────────────────────────────────────────────────
    const whole_ = !span
    const counts = useMemo((): ScopeCounts | null => {
        if (state.corridor && whole_) return corridor ? corridorTotals(corridor) : null
        if (!state.corridor && whole_) return info ? entityTotals(info) : null
        // Spans count their rows (own and, when loaded, xs).
        const own = entitySpan ? spanQ.data : rawRows?.filter(c => c.own_entity === null || c.own_entity === undefined)
        if (!own) return null
        const xsRows = state.corridor
            ? (inclusive ? rawRows?.filter(c => c.own_entity !== null && c.own_entity !== undefined) : null)
            : (xsSpan.data ?? null)
        return { own: crashTotals(own), xs: xsRows ? crashTotals(xsRows) : null }
    }, [state.corridor, whole_, corridor, info, entitySpan, spanQ.data, rawRows, inclusive, xsSpan.data])

    /** Summary rows for the plots / year strip, in the current view (inclusive adds `n_xs`). */
    const summary = useMemo((): RoadSummaryRow[] | null => {
        if (!state.corridor && whole_) {
            if (!roadSummary) return null
            return inclusive ? inclusiveSummary(roadSummary) : roadSummary
        }
        if (!crashes) return null
        return summarizeCrashes(crashes, c => isUnplaced(c) || isPinned(c))
    }, [state.corridor, whole_, roadSummary, inclusive, crashes])

    // Of the road's crashes without a precise location (road-summary `n_unplaced`), those outside
    // this span: not listed or counted here.
    const unplacedRoad = useMemo(() => (roadSummary ?? []).reduce((s, r) => s + (r.n_unplaced ?? 0), 0), [roadSummary])
    const pinnedHere = useMemo(() => (entitySpan && spanQ.data ? spanQ.data.filter(isPinned).length : 0), [entitySpan, spanQ.data])
    const unplacedElsewhere = entitySpan ? Math.max(0, unplacedRoad - pinnedHere) : 0

    // ─── Geometry ───────────────────────────────────────────────────────────────────────────────
    const shownSpan = dragSpan ?? span
    const paths = useMemo((): [number, number][][] => {
        if (state.corridor) {
            return corridorMembers.flatMap(m => {
                const ms = shownSpan ? memberSpan(m, shownSpan) : { lo: 0, hi: m.chain_mi }
                return ms ? spanPaths(m.points, ms) : []
            })
        }
        return shownSpan ? spanPaths(points, shownSpan) : []
    }, [state.corridor, corridorMembers, shownSpan, points])
    const handles = useMemo((): { end: 0 | 1; lngLat: [number, number] }[] => {
        const span = shownSpan
        if (!span) return []
        const at = (c: number): [number, number] | null => {
            if (!state.corridor) return pointAtChain(points, c)
            for (const m of corridorMembers) {
                const ms = memberSpan(m, { lo: c, hi: c })
                if (!ms) continue
                const p = pointAtChain(m.points, ms.lo)
                if (p) return p
            }
            return null
        }
        return ([[0, span.lo], [1, span.hi]] as const).flatMap(([end, c]) => {
            const p = at(c)
            return p ? [{ end, lngLat: p }] : []
        })
    }, [shownSpan, state.corridor, points, corridorMembers])
    const anchorPoint = useMemo((): [number, number] | null => {
        if (state.corridor) {
            if (canchor === null) return null
            for (const m of corridorMembers) {
                const ms = memberSpan(m, { lo: canchor, hi: canchor })
                const p = ms && pointAtChain(m.points, ms.lo)
                if (p) return p
            }
            return null
        }
        return anchor !== null ? pointAtChain(points, anchor) : null
    }, [state.corridor, canchor, anchor, corridorMembers, points])

    // ─── Labels ─────────────────────────────────────────────────────────────────────────────────
    const label = useMemo((): string => {
        const span = shownSpan
        const mi = (s: Span) => `${(s.hi - s.lo).toFixed(2)} mi`
        if (state.corridor) {
            const name = corridor ? `${corridor.name} corridor (${corridor.n_entities} roads)` : "Corridor"
            return span ? `${name}: ${span.lo.toFixed(2)}–${span.hi.toFixed(2)} mi (${mi(span)})` : name
        }
        if (!span) return "Whole road"
        const { from, to } = spanEnds(blocks, span)
        const between = from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `to ${to}` : null
        const what = level === "block" ? "Block" : custom ? "Selected span" : "Stretch"
        return `${what}: ${between ? `${between}, ` : ""}${mi(span)}`
    }, [state.corridor, corridor, shownSpan, blocks, level, custom])

    useAction("map:road-scope-narrower", {
        label: "Road scope: narrower (corridor → road → stretch → block)",
        group: "Map",
        defaultBindings: ["["],
        keywords: ["road", "block", "stretch", "span", "scope", "zoom in"],
        enabled: hotkeys && v5 && entity !== null,
        handler: () => step(-1),
    })
    useAction("map:road-scope-wider", {
        label: "Road scope: wider (block → stretch → road → corridor)",
        group: "Map",
        defaultBindings: ["]"],
        keywords: ["road", "block", "stretch", "corridor", "scope", "zoom out"],
        enabled: hotkeys && v5 && entity !== null,
        handler: () => step(1),
    })
    useAction("map:road-inclusive", {
        label: "Road crashes: toggle intersection crashes on cross streets",
        group: "Map",
        defaultBindings: ["m i"],
        keywords: ["road", "intersection", "inclusive", "exclusive", "cross street"],
        enabled: hotkeys && v5 && entity !== null,
        handler: () => setInclusive(!inclusive),
    })

    return {
        /** v5 data: scopes and the inclusive view are available. */
        v5,
        state, level, custom, available, label, span,
        corridor, corridorMembers,
        inclusive, setInclusive,
        blocks,
        step, toLevel, clear, setState, onRoadClick, dragEnd, anchorOnLoad, dragging: dragSpan !== null,
        crashes, displayChain,
        crashesError: [whole, spanQ, xsWhole, xsSpan, ...memberCrashes, ...memberXs].find(q => q.error)?.error ?? null,
        crashesLoading: (rowsLoading || names.isFetching) && ![whole, spanQ, xsWhole, xsSpan, ...memberCrashes, ...memberXs].some(q => q.error),
        counts, summary, unplacedElsewhere, pinnedHere,
        paths, handles, anchorPoint,
    }
}

export type RoadScope = ReturnType<typeof useRoadScope>
