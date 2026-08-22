/** Client hook for the dynamic cells API (`crashes-cells-api`).
 *
 *  **Shard-keyed.** NJ spans 2 level-4 S2 shard tokens (`89b`, `89d`);
 *  the client fires one request per shard in parallel. Each shard's
 *  response is cached by URL. Panning over already-fetched shards =
 *  zero new requests.
 *
 *  Spec: `specs/cfw-cells-api.md`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { StackedHex } from "./StackedHexLayer"
import { CELLS_API_BASE } from "./config"
import type { Bbox } from "./v2"
import {
    pickS2LevelForPixels,
    tokenCenterLngLat,
    tokenLevel,
    tokenToParent,
} from "./s2"

export type CellsApiFilter = {
    yearRange: [number, number]
    severities: Set<"f" | "i" | "p">
    viewport: Bbox
    viewportLat: number
    zoom: number
    hexPxTarget?: number
    /** Override S2 level; bypasses `pickS2LevelForPixels`. */
    resOverride?: number
    /** Optional GeoJSON-like polygon (`[lon, lat][]`) to clip the
     *  response to. The worker drops cells whose center isn't in the
     *  polygon — used for `/c/<county>` and `/c/<county>/<muni>` views
     *  to scope to the admin boundary instead of the (pitch-inflated)
     *  viewport bbox. */
    clipPolygon?: [number, number][]
}

type CellRow = {
    h3: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
    fatal_years?: number[]
    /** Sidecar labels multiplexed into the response by the cells-api
     *  worker (`pyramid_sld/` join). Optional — missing shard degrades
     *  to no label on the tooltip. */
    sld_name?: string
    cross_sld_name?: string
    mun?: string
    county?: string
}

type CellsResponse = {
    res: number
    year_range: [number, number]
    data_version: string
    source: "pyramid" | "raw"
    cells: CellRow[]
}

/** A pre-aggregated `(shard_res, data_res)` slice. Mirrors the
 *  worker-side `PyramidCombo`. The per-combo `shard_cells` list is no
 *  longer shipped (the worker reads shards with `missingOk`); only the
 *  `(shard_res, data_res)` set and counts remain. */
export type PyramidCombo = {
    shard_res: number
    data_res: number
    shard_count?: number
    row_count?: number
    byte_size?: number
}

type Manifest = {
    schema_version: number
    data_version: string
    base_res: number
    shard_res: number
    pyramid_levels: number[]
    /** Multi-resolution combos (schema_version >= 4). Empty/missing on older
     *  manifests; client falls back to single shard_res. */
    pyramid_combos?: PyramidCombo[]
    year_range: [number, number]
    shard_cells: string[]
}

/** One cell of a multi-resolution cover. The pair `(shard_res, h3)`
 *  identifies a specific parquet shard. */
export type CoverCell = {
    shard_res: number
    h3: string
}

export type CellsApiPlan = {
    kind: "hex"
    res: number
    source: "pyramid" | "raw"
    reason: string
    cellCount?: number
    /** Number of shards that contributed to this response. */
    shardCount?: number
    /** Sum of unique batch-response byte sizes for this view's shards
     *  (JSON body bytes, gzip-decompressed by fetch). Undefined until
     *  the fetch resolves. */
    fetchedBytes?: number
    /** Sum of unique batch-response *wire* bytes (compressed transfer,
     *  via Resource Timing `encodedBodySize`). 0 when the browser
     *  withholds timing (cross-origin without `Timing-Allow-Origin`) —
     *  callers should treat 0 as "unknown", not "free". */
    wireBytes?: number
    /** Heterogeneous cover the client picked for this view. The debug
     *  overlay outlines these to make the cover visible. */
    cover?: CoverCell[]
}

/** Per-shard response cache. Keyed by full URL — same shard with
 *  different (res, years, sevs, polygon) is a distinct entry. Pan over
 *  already-fetched shards = zero new requests. */
const shardCache = new Map<string, Promise<CellsResponse>>()

/** Metrics: for each shard URL, the batch URL it was served from + total
 *  bytes of that batch's response. Multiple shards share one `BatchInfo`
 *  object, so summing bytes across a view dedupes naturally via
 *  `new Set([...])`. `bytes` is populated when the batch fetch resolves;
 *  reads (via `getFetchedBytes`) happen after `await`, so the value is
 *  present. */
type BatchInfo = { url: string; bytes: number; wireBytes: number }
const shardBatch = new Map<string, BatchInfo>()

/** Sum of unique batch-response byte sizes across the given shard URLs.
 *  Used by the debug metrics block. */
export function getFetchedBytes(shardUrls: string[]): number {
    const seen = new Set<BatchInfo>()
    for (const u of shardUrls) {
        const info = shardBatch.get(u)
        if (info) seen.add(info)
    }
    let total = 0
    for (const info of seen) total += info.bytes
    return total
}

/** Like `getFetchedBytes` but the compressed (over-the-wire) sizes. */
export function getWireBytes(shardUrls: string[]): number {
    const seen = new Set<BatchInfo>()
    for (const u of shardUrls) {
        const info = shardBatch.get(u)
        if (info) seen.add(info)
    }
    let total = 0
    for (const info of seen) total += info.wireBytes
    return total
}

/** Manifest is fetched once (cells-api version is stable across a
 *  page lifetime; redeploys flip `data_version` but not `shard_*`). */
let manifestPromise: Promise<Manifest> | null = null
function loadManifest(): Promise<Manifest> {
    if (manifestPromise) return manifestPromise
    manifestPromise = fetch(`${CELLS_API_BASE}/v1/manifest`).then(async r => {
        if (!r.ok) throw new Error(`manifest fetch ${r.status}`)
        return await r.json() as Manifest
    })
    manifestPromise.catch(() => { manifestPromise = null })
    return manifestPromise
}

/** Max shards bundled into one batched `/v1/cells` request. Per-shard
 *  URLs maximize CF edge-cache reuse (one canonical URL per shard ×
 *  filter), but small shards still pay the worker cold-start (~100–500ms)
 *  per request. Batching ≤25 shards amortizes cold-start over many
 *  parquet reads. The batch URL stays well under the 16KB header cap
 *  (25 × 15-char h3 + commas ≈ 400 bytes). Per-shard `shardCache`
 *  entries are seeded from the batch response so future single-shard
 *  re-requests still hit memory without re-fetching. */
const BATCH_SIZE = 25

/** Level below which the fetch drops the 4 string columns (`sld_name`,
 *  `cross_sld_name`, `mun`, `county`) by sending `labels=nums`.
 *
 *  Was `12` — an **H3 resolution** (r12 ≈ 19 m, hover-scale) left behind
 *  by the S2 migration and then compared against *S2 levels*, where l12 is
 *  a 1.9 km cell. Every real pick lands at l12-l20, so the gate never
 *  fired and every request paid the label tax: measured 2026-08-22, labels
 *  are 45-50% of the payload (statewide-mid l14: 5.97 MB, of which 2.97 MB
 *  is strings; Hudson-fit l17: 30 MB / 18 MB).
 *
 *  l18 (~30 m) is the S2 analog of the original intent: at l17 and coarser
 *  a cell spans multiple streets, so its centroid's `sld_name` is a
 *  misleading label as well as an expensive one. The worker applies a
 *  second, count-based cap (`label_max_cells`) for views that are fine
 *  enough to pass this gate but still return tens of thousands of cells.
 *  The tooltip degrades gracefully (`CrashTooltip` skips the label header
 *  when `sld_name` is missing). See `specs/labels-on-demand.md` for the
 *  hover-fetch design that would restore labels everywhere. */
const LABELS_MIN_S2_LEVEL = 18

function buildBatchUrl(
    shards: string[], res: number, filter: CellsApiFilter, polygonStr: string | null,
    shardRes: number,
): string {
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const params = new URLSearchParams({
        cells: shards.join(","),
        res: String(res),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
        shard_res: String(shardRes),
    })
    // Explicit until the worker drops H3 support (h3-removal Phase 2);
    // after that the param can go entirely.
    params.set("grid", "s2")
    if (res < LABELS_MIN_S2_LEVEL) params.set("labels", "nums")
    if (polygonStr) params.set("polygon", polygonStr)
    return `${CELLS_API_BASE}/v1/cells?${params}`
}

/** Ensure each per-shard URL has a `shardCache` entry. Cache misses get
 *  batched: group by `shard_res` tier (the worker URL needs one tier per
 *  request), chunk into ≤BATCH_SIZE batches, fire one fetch per batch.
 *  Per-shard cache entries are sub-promises that filter the batch result
 *  down to cells whose parent at `tier` matches the shard. */
function ensureShardsCached(
    cover: CoverCell[],
    perShardUrls: string[],
    res: number,
    filter: CellsApiFilter,
    polygonStr: string | null,
): void {
    const missingByTier = new Map<number, { url: string; h3: string }[]>()
    for (let i = 0; i < cover.length; i++) {
        if (shardCache.has(perShardUrls[i])) continue
        const tier = cover[i].shard_res
        let arr = missingByTier.get(tier)
        if (!arr) { arr = []; missingByTier.set(tier, arr) }
        arr.push({ url: perShardUrls[i], h3: cover[i].h3 })
    }
    for (const [tier, entries] of missingByTier) {
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE)
            const batchUrl = buildBatchUrl(batch.map(e => e.h3), res, filter, polygonStr, tier)
            // Per-batch metrics: shared across all shard URLs from this
            // fetch. `bytes` is 0 until the fetch resolves; the debug
            // panel reads it via `getFetchedBytes` only after the effect
            // has awaited its shard promises, so the value is populated.
            const info: BatchInfo = { url: batchUrl, bytes: 0, wireBytes: 0 }
            const batchPromise: Promise<CellsResponse> = (async () => {
                const r = await fetch(batchUrl)
                if (!r.ok) throw new Error(`cells api ${r.status}: ${await r.text().catch(() => "")}`)
                const buf = await r.arrayBuffer()
                info.bytes = buf.byteLength
                // Compressed transfer size, via Resource Timing. The
                // worker sets `Timing-Allow-Origin` for dev hosts; when
                // it's absent the entry reports 0 (treated as unknown).
                const entry = performance.getEntriesByName(batchUrl).at(-1) as PerformanceResourceTiming | undefined
                info.wireBytes = entry?.encodedBodySize ?? 0
                return JSON.parse(new TextDecoder().decode(buf)) as CellsResponse
            })()
            for (const entry of batch) {
                shardBatch.set(entry.url, info)
                const shardPromise = batchPromise.then(resp => ({
                    ...resp,
                    cells: resp.cells.filter(c => tokenToParent(c.h3, tier) === entry.h3),
                }))
                shardPromise.catch(() => {
                    if (shardCache.get(entry.url) === shardPromise) shardCache.delete(entry.url)
                    shardBatch.delete(entry.url)
                })
                shardCache.set(entry.url, shardPromise)
            }
        }
    }
}

/** Refetch debounce in ms. The viewport debounce coalesces a drag's
 *  worth of changes into one shard-set computation. Per-shard fetches
 *  are still independently cached, so a small pan that crosses a
 *  shard boundary only pays for the new shard. 500ms (was 250ms): each
 *  worker request can take seconds on a cold start, so the cost of
 *  firing during a mid-drag pause is high — better to wait for a
 *  longer settle. */
const DEBOUNCE_MS = 500

/** Render budget — max hex bins shown on screen. The picker no longer
 *  caps based on theoretical max (`area / hex_area`); it picks res
 *  purely from zoom. The consumer (CrashMapSection) coarsens
 *  client-side via S2 parent rollup if a fetch comes back over budget
 *  (lossless: parent count = sum of children).
 *
 *  Bumped 30k → 60k after multi-res sharding landed: at z~10 over urban
 *  NJ the actual in-viewport r10 cell count is ~42k. 30k forced a coarsen
 *  to r9 (defeating the point of finer sharding). Then 60k → 100k:
 *  statewide r9 fits in ~66.5k cells, and 60k was forcing r9 → r8 at
 *  z≈9.6 (the default full-screen view). Deck.gl's HexagonLayer-style
 *  instanced rendering handles 100k+ smoothly. */
export const CELLS_BUDGET = 100000

/** Per-shard cap sent to the worker as `?maxCells=`. Worker walks
 *  coarser if a shard's cells would exceed this — only triggers
 *  adaptation for genuinely dense shards (e.g. urban Hudson at r10+).
 *  Splitting CELLS_BUDGET / N_shards is too tight: at N=31 every shard
 *  gets ~1k budget and most adapt unnecessarily. A flat 5k means
 *  sparse shards keep requested res; total cells across all shards is
 *  bounded by N × 5000 worst-case but realistically much less. The
 *  client coarsens the union if total still exceeds CELLS_BUDGET. */
const SHARD_MAX_CELLS = 5000

/** Sutherland-Hodgman polygon-vs-axis-aligned-rectangle clip. Input ring
 *  is `[lon, lat]`, bbox is `[w, s, e, n]`. Output is the polygon clipped
 *  to the rectangle (CCW or CW, same as input; possibly empty if the
 *  polygon doesn't overlap the rectangle). The polygon is assumed to be
 *  a simple ring (no holes); the input may be open (last !== first) or
 *  closed — output is open (no implicit closing vertex).
 *
 *  Used to compute `polygon ∩ viewport_bbox`: shrinks the clip used for
 *  shard selection and the cells-api `polygon=` param when the user has
 *  zoomed into part of a county/muni, so we fetch only the visible
 *  region instead of the full scope. */
export function clipPolygonToBbox(
    poly: [number, number][],
    [w, s, e, n]: Bbox,
): [number, number][] {
    if (poly.length < 3) return []
    type Edge = { axis: 0 | 1; inside: (v: number) => boolean; intersect: (a: [number, number], b: [number, number]) => [number, number] }
    const edges: Edge[] = [
        { axis: 0, inside: v => v >= w, intersect: (a, b) => intersectAt(a, b, 0, w) },
        { axis: 0, inside: v => v <= e, intersect: (a, b) => intersectAt(a, b, 0, e) },
        { axis: 1, inside: v => v >= s, intersect: (a, b) => intersectAt(a, b, 1, s) },
        { axis: 1, inside: v => v <= n, intersect: (a, b) => intersectAt(a, b, 1, n) },
    ]
    let output = poly
    for (const { axis, inside, intersect } of edges) {
        if (output.length === 0) return []
        const input = output
        output = []
        for (let i = 0; i < input.length; i++) {
            const cur = input[i]
            const prev = input[(i - 1 + input.length) % input.length]
            const curIn = inside(cur[axis])
            const prevIn = inside(prev[axis])
            if (curIn) {
                if (!prevIn) output.push(intersect(prev, cur))
                output.push(cur)
            } else if (prevIn) {
                output.push(intersect(prev, cur))
            }
        }
    }
    return output
}

/** Planar shoelace area of a `[lon, lat]` ring, in m² — local
 *  equirectangular scaling about the ring's mean latitude. Accurate to
 *  well under 1% at NJ spans; used for the scoped bins-budget (see
 *  `CrashMapSection.hexPxTarget`), where only the order of magnitude
 *  matters. Open or closed rings accepted. */
export function polygonAreaM2(ring: [number, number][]): number {
    if (ring.length < 3) return 0
    // Scale about the lat-extent midpoint (not the vertex mean, which
    // shifts with vertex density / an explicit closing point).
    let latMin = Infinity, latMax = -Infinity
    for (const [, lat] of ring) { if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat }
    const lat0 = (latMin + latMax) / 2
    const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180)
    const ky = 110_540
    let acc = 0
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]
        const [x2, y2] = ring[(i + 1) % ring.length]
        acc += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky)
    }
    return Math.abs(acc) / 2
}

function intersectAt(
    a: [number, number], b: [number, number], axis: 0 | 1, val: number,
): [number, number] {
    const denom = b[axis] - a[axis]
    if (denom === 0) return [a[0], a[1]]
    const t = (val - a[axis]) / denom
    return axis === 0
        ? [val, a[1] + t * (b[1] - a[1])]
        : [a[0] + t * (b[0] - a[0]), val]
}

/** Encode a polygon (`[lon, lat][]`) as flat `lon,lat,...` rounded to
 *  4 decimals (~10m). County outlines are 50–500 verts → 1–5KB. */
function encodePolygon(poly: [number, number][]): string {
    return poly.flatMap(([lon, lat]) => [lon.toFixed(4), lat.toFixed(4)]).join(",")
}

function buildShardUrl(
    shard: string, res: number, filter: CellsApiFilter, polygonStr: string | null,
    maxCells: number, shardRes?: number,
): string {
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const params = new URLSearchParams({
        cells: shard,
        res: String(res),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
    })
    // Combo path skips `maxCells` for now — worker supports it (see
    // `specs/cells-api-combo-maxcells.md`) but wiring the client to
    // actually use it requires a per-shard render path so
    // heterogeneously-coarsened shards don't force the whole viewport
    // to the coarsest returned res. Deferred followup.
    if (shardRes != null) params.set("shard_res", String(shardRes))
    else params.set("maxCells", String(maxCells))
    if (polygonStr) params.set("polygon", polygonStr)
    return `${CELLS_API_BASE}/v1/cells?${params}`
}

/** Aggregate finer-res cells into their res-`targetRes` parents. Used
 *  to normalize cross-shard responses when the worker's adaptive res
 *  picked different levels per shard (rare — only when shard data
 *  densities diverge enough to straddle a budget boundary). */
function rollupCellsToRes(cells: CellRow[], targetRes: number): CellRow[] {
    const out = new Map<string, CellRow>()
    for (const c of cells) {
        const sr = tokenLevel(c.h3)
        if (sr <= targetRes) { out.set(c.h3, c); continue }
        const ph = tokenToParent(c.h3, targetRes)
        let p = out.get(ph)
        if (!p) {
            p = { h3: ph, n_fatal: 0, n_inj_ped: 0, n_inj_other: 0, n_pdo: 0, n_vehs: 0 }
            out.set(ph, p)
        }
        p.n_fatal += c.n_fatal
        p.n_inj_ped += c.n_inj_ped
        p.n_inj_other += c.n_inj_other
        p.n_pdo += c.n_pdo
        p.n_vehs += c.n_vehs
        if (c.fatal_years && c.fatal_years.length > 0) {
            // Merge child year-sets into the parent; dedupe + sort at end.
            (p.fatal_years ??= []).push(...c.fatal_years)
        }
    }
    for (const p of out.values()) {
        if (p.fatal_years) p.fatal_years = [...new Set(p.fatal_years)].sort((a, b) => a - b)
    }
    return [...out.values()]
}

function cellsToStackedHex(cells: CellRow[]): StackedHex[] {
    const out: StackedHex[] = []
    for (const c of cells) {
        const total = c.n_fatal + c.n_inj_ped + c.n_inj_other + c.n_pdo
        if (total === 0) continue
        // S2 tokens go through `nodes2ts` — cell-center in one call, no
        // boundary polygon needed since the render uses `center` + an
        // S2-level-derived radius.
        const center: [number, number] = tokenCenterLngLat(c.h3)
        out.push({
            h3: c.h3,
            center,
            fatal: c.n_fatal,
            pedInj: c.n_inj_ped,
            otherInj: c.n_inj_other,
            pdo: c.n_pdo,
            total,
            fatalYears: c.fatal_years,
            sld_name: c.sld_name,
            cross_sld_name: c.cross_sld_name,
            mun: c.mun,
            county: c.county,
        })
    }
    return out
}

export function useCellsApi(filter: CellsApiFilter | null):
    | { status: "loading"; data?: StackedHex[]; plan?: CellsApiPlan; error?: undefined }
    | { status: "ready"; data: StackedHex[]; plan: CellsApiPlan; error?: undefined; refetching?: boolean }
    | { status: "error"; error: string; data?: StackedHex[]; plan?: CellsApiPlan } {

    const [manifest, setManifest] = useState<Manifest | null>(null)
    useEffect(() => {
        let cancelled = false
        loadManifest().then(m => { if (!cancelled) setManifest(m) }).catch(() => {})
        return () => { cancelled = true }
    }, [])

    // Snap viewport to a power-of-2 grid before picking the cover.
    // Adaptive: grid step ≈ viewport span / 4, so the snapped bbox is at
    // most ~1.5× the visible area at any zoom (vs. ~10× for a fixed
    // 0.25° grid at z≥11, which inflated the initial cover past the
    // refinement cap). Power-of-2 keeps grid lines nested across zooms
    // — zoom-out includes zoom-in cells, so panning across zooms still
    // hits parent-bbox cache entries.
    //
    // Trade-off: tighter grid means fewer cache hits on big pans. At
    // z=10 the grid is ~7km, at z=12 ~1.7km — small but real, and
    // the refinement gain outweighs cache friction.
    const usingPoly = !!(filter?.clipPolygon && filter.clipPolygon.length >= 3)
    const snappedBbox = useMemo<Bbox | null>(() => {
        if (!filter) return null
        const [w, s, e, n] = filter.viewport
        const span = Math.max(e - w, n - s)
        // G = 2^ceil(log2(4 / span)), clamped ≥ 4 (0.25° floor at low
        // zoom keeps statewide panning cache-stable).
        const k = Math.max(2, Math.ceil(Math.log2(4 / Math.max(span, 1e-6))))
        const G = Math.pow(2, k)
        return [
            Math.floor(w * G) / G,
            Math.floor(s * G) / G,
            Math.ceil(e * G) / G,
            Math.ceil(n * G) / G,
        ] as Bbox
    }, [filter?.viewport])
    const bboxKey = snappedBbox ? snappedBbox.join(",") : null

    const pick = useMemo<{ res: number; cover: CoverCell[]; reason: string } | null>(() => {
        if (!filter || !manifest || !snappedBbox) return null
        // NJ spans only 2 level-4 S2 shard tokens per e's phase-3 build
        // (`89b`, `89d`), so the cover is hardcoded. Fine-grained
        // viewport pruning happens server-side via `s2-range.ts`
        // row-group filtering. Bumping to `-s 6` or finer would motivate
        // a real S2 cover algorithm — deferred as an optimization (see
        // `specs/s2-pyramid.md`).
        const level = filter.resOverride != null
            ? filter.resOverride
            : pickS2LevelForPixels(filter.hexPxTarget ?? 1.2, filter.zoom, filter.viewportLat)
        // Level clamp mirrors the worker's pyramid envelope (phase 8:
        // base l21, data levels 4-21).
        const S2_MIN = 4, S2_MAX = 21
        const clamped = Math.max(S2_MIN, Math.min(S2_MAX, level))
        const S2_STATEWIDE_SHARDS = ["89b", "89d"]
        const cover: CoverCell[] = S2_STATEWIDE_SHARDS.map(h3 => ({ h3, shard_res: 4 }))
        return { res: clamped, cover, reason: `s2 l${clamped} · ${cover.length} shard${cover.length > 1 ? "s" : ""}` }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter?.zoom, filter?.viewportLat, filter?.hexPxTarget, filter?.resOverride, manifest, bboxKey, usingPoly, filter?.clipPolygon])

    // `polygonStr` for the worker `polygon=` arg. Tied to the snap-grid
    // bbox so per-URL cache hits across users/sessions at the same
    // viewport remain stable, while shrinking the response from
    // "everything in the requested r9 shard" to "just the cells inside
    // the visible bbox". For scoped views the polygon is
    // `clipPolygon ∩ snappedBbox` so urban hexes outside the county
    // outline still get filtered out worker-side.
    const polygonStr = useMemo<string | null>(() => {
        if (!filter || !snappedBbox) return null
        if (usingPoly) {
            const clipped = clipPolygonToBbox(filter.clipPolygon!, snappedBbox)
            if (clipped.length >= 3) return encodePolygon(clipped)
            return encodePolygon(filter.clipPolygon!)
        }
        // Statewide: ship the snapped bbox itself as a 4-vertex polygon.
        const [w, s, e, n] = snappedBbox
        return encodePolygon([[w, n], [e, n], [e, s], [w, s], [w, n]])
    }, [usingPoly, filter?.clipPolygon, bboxKey])

    const shardsKey = useMemo(() => {
        if (!filter || !pick || pick.cover.length === 0) {
            return { shards: [] as string[], urls: [] as string[], polygonStr: null as string | null }
        }
        // One URL per cover cell. Each cell carries its own shard_res
        // (heterogeneous cover ⇒ different parquet subdirs per cell).
        const perShardCap = SHARD_MAX_CELLS
        const urls = pick.cover.map(c => buildShardUrl(c.h3, pick.res, filter, polygonStr, perShardCap, c.shard_res))
        const shards = pick.cover.map(c => c.h3)
        return { shards, urls, polygonStr }
        // The covers themselves are stable across small pans thanks to
        // snappedBbox. Listing each primitive separately avoids drag-frame
        // churn on the array refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pick?.res, pick?.cover, polygonStr, filter?.yearRange, filter?.severities])

    const [state, setState] = useState<{
        urls: string[]
        data: StackedHex[]
        status: "loading" | "ready" | "error"
        plan?: CellsApiPlan
        error?: string
    }>({ urls: [], data: [], status: "loading" })

    // `pick` gets a new object ref every drag frame (its `reason` string
    // includes `bboxArea`, which changes on every viewport update), but
    // `pick.res` is stable across small pans and is the only field of
    // `pick` that affects URL building. Read via ref inside the effect so
    // a fresh `pick.reason` doesn't re-trigger fetches every frame.
    const pickRef = useRef(pick)
    pickRef.current = pick

    useEffect(() => {
        if (!shardsKey || !pickRef.current || !filter) return
        const { urls } = shardsKey
        const pickAtFire = pickRef.current
        if (urls.length === 0) {
            setState({ urls, data: [], status: "ready", plan: {
                kind: "hex", res: pickAtFire.res, source: "pyramid",
                reason: `${pickAtFire.reason} · 0 shards`, cellCount: 0, shardCount: 0,
                fetchedBytes: 0,
                wireBytes: 0,
                cover: pickAtFire.cover,
            } })
            return
        }
        let cancelled = false

        // Hot path: every URL already cached → resolve synchronously
        // (microtask), no debounce, no loading flicker.
        const allCached = urls.every(u => shardCache.has(u))
        const fire = async () => {
            try {
                ensureShardsCached(pickAtFire.cover, urls, pickAtFire.res, filter, polygonStr)
                const responses = await Promise.all(urls.map(u => shardCache.get(u)!))
                if (cancelled) return
                // Worker walks coarser when a shard's count would overflow
                // its budget, so different shards may return at different
                // res. Pick the coarsest returned res; any finer shards
                // get coarsened locally to match (lossless: parent count =
                // sum of children).
                let source: "pyramid" | "raw" = "pyramid"
                let minRes = Infinity
                for (const r of responses) {
                    if (r.source === "raw") source = "raw"
                    if (r.res < minRes) minRes = r.res
                }
                const finalRes = minRes === Infinity ? pickAtFire.res : minRes
                const allCells: CellRow[] = []
                for (const r of responses) {
                    if (r.res === finalRes) {
                        for (const c of r.cells) allCells.push(c)
                    } else {
                        // Aggregate finer cells up to finalRes via parent-cell rollup.
                        const rolled = rollupCellsToRes(r.cells, finalRes)
                        for (const c of rolled) allCells.push(c)
                    }
                }
                const data = cellsToStackedHex(allCells)
                const requestedRes = pickAtFire.res
                const adapted = finalRes !== requestedRes
                const reason = adapted
                    ? `${source} · ${pickAtFire.reason} · adapted r${requestedRes}→r${finalRes} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`
                    : `${source} · ${pickAtFire.reason} · ${urls.length} shard${urls.length > 1 ? "s" : ""}`
                setState({
                    urls, data, status: "ready",
                    plan: {
                        kind: "hex", res: finalRes, source,
                        reason,
                        cellCount: data.length, shardCount: urls.length,
                        fetchedBytes: getFetchedBytes(urls),
                        wireBytes: getWireBytes(urls),
                        cover: pickAtFire.cover,
                    },
                })
            } catch (e) {
                if (!cancelled) setState(s => ({ ...s, urls, status: "error", error: String(e) }))
            }
        }
        if (allCached) { fire(); return () => { cancelled = true } }
        const t = setTimeout(() => {
            if (cancelled) return
            setState(s => ({ ...s, urls, status: "loading" }))
            fire()
        }, DEBOUNCE_MS)
        return () => { cancelled = true; clearTimeout(t) }
    }, [shardsKey])

    if (state.status === "ready") return { status: "ready", data: state.data, plan: state.plan! }
    if (state.status === "error") return { status: "error", error: state.error ?? "unknown", data: state.data, plan: state.plan }
    return { status: "loading", data: state.data.length > 0 ? state.data : undefined, plan: state.plan }
}
