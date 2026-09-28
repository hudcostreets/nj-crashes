/** Heatmap render strategy C (`?hr=c`, the default) — a mercator-tile pyramid of baked KDE
 *  surfaces.
 *
 *  Each visible tile is baked at its own zoom (so the raster is always ~screen-resolution) and
 *  drawn as a `BitmapLayer`. Two things make the tiling seamless:
 *    - **kernel bleed:** a tile splats the cells of a margin around it, but its bake grid is the
 *      *core* tile bbox, so a neighbor cell's Gaussian tail contributes to the edge without the
 *      tile drawing outside its bounds (adjacent core grids tile exactly — no gaps, no
 *      double-draw).
 *    - **shared normalization:** all visible tiles colorize against one `vmax` (a high quantile
 *      of the density across them), so there's no brightness seam at a density gradient.
 *
 *  Cost control (specs/map-mobile-perf.md § Round 3):
 *    - **fetch unit = the parent tile** (`tileZ − 1`, padded by `FETCH_MARGIN_FRAC`, which covers
 *      each child's bleed margin): ¼ the requests of per-tile fetches, and the same URL for every
 *      user. Uses the lean wire format (`leanCells.ts`): with the worker's `group_year`
 *      capability a year *sub*-range fetches one per-(cell, year) table over all years +
 *      severities, so later year / severity changes re-aggregate locally (0 requests). Scoped
 *      (county / muni) maps clip each fetch to the scope polygon, worker-side.
 *    - **bake caches:** a tile's density grid is memoized per (tile, table, filter, σ, size) and
 *      its colorized image per (grid, `vmax`); `vmax` is sticky within ±25% (`stickyVmax`), so a
 *      pan that keeps the tile set only splats / colorizes the tiles it newly reached.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { BitmapLayer } from "@deck.gl/layers"
import { WebMercatorViewport } from "@deck.gl/core"
import { pickS2LevelForPixels, clampS2Level, S2_EDGE_METERS } from "./s2"
import { CELLS_API_BASE } from "./config"
import { splatDensity, colorizeDensity, densityQuantile, type Bounds, type DensityGrid } from "./bakeDensity"
import type { StackedCell } from "./StackedCellLayer"
import type { ColormapName } from "./colormap"
import { tilesForBounds, tileToBounds, padBounds, tileKey, type Tile } from "./tileMath"
import { aggregateLeanTables, leanParams, type LeanTable, type Severity } from "./leanCells"
import { clipPolygonToBbox, encodePolygon, fetchLean, loadManifest } from "./useCellsApi"

const { round, min, max, ceil, pow, cos, PI } = Math

/** Each tile is baked at its *displayed* device-pixel size so the `BitmapLayer`
 *  never up-samples (which is what made a fixed 256px bake look blurry): a
 *  mercator tile at its native zoom draws at 512 CSS px — ×devicePixelRatio
 *  device px (2× on retina). We size the grid to that, clamped to [MIN, CAP] to
 *  bound the CPU splat/colorize cost. */
const TILE_PX_MIN = 256
const TILE_PX_CAP = 1024
/** Bleed margin a *baked* tile needs, as a fraction of its span on each side. */
const MARGIN_FRAC = 0.3
/** Margin of a *fetched* (parent) tile: half the child margin in parent spans, i.e. the same
 *  distance — so every child's bleed margin lies inside its parent's fetch. */
const FETCH_MARGIN_FRAC = MARGIN_FRAC / 2
const SHARDS = "89b,89d"
const MAX_CELLS = 150_000
/** Shared-`vmax` quantile (see `densityQuantile`): the top 0.5% saturate. */
const VMAX_QUANTILE = 0.995
/** Keep the previous `vmax` while the new quantile is within this factor of it (see `stickyVmax`). */
const VMAX_STICKY = 1.25
/** Minimum σ as a fraction of the S2 cell edge, so cells never read as a lattice
 *  of dots (only binds when cells are much larger than `sigmaPx`). */
const SIGMA_FLOOR_FRAC = 0.35
/** How long the view must hold still before re-tiling. */
const SETTLE_MS = 180
/** Web-Mercator meters per CSS px (dup of `CrashMap.metersPerPixel`, which
 *  imports this module). */
const metersPerPixel = (zoom: number, lat: number) => 156543.03 * cos(lat * PI / 180) / pow(2, zoom)

export type HeatTileFilter = {
    yearRange: [number, number]
    severities: Set<Severity>
    /** Scope (county / muni) outline: cells whose centers fall outside are dropped worker-side. */
    clipPolygon?: [number, number][] | null
}

export type HeatTileRenderOpts = {
    colormap: ColormapName
    gamma: number
    alphaKnee: number
    /** Kernel σ in CSS px at the tile's zoom — a constant on-screen blur, so an
     *  S2-level change swaps in finer data without a visible jump in softness.
     *  Floored at `SIGMA_FLOOR_FRAC` × the cell edge (past the finest level). */
    sigmaPx: number
    /** Colormap lift for the faintest density (see `colorizeDensity`'s `floor`). */
    floor: number
    /** Target cell size (px) fed to the S2-level picker. */
    cellPxTarget: number
    /** Layer opacity (0–1). <1 lets the basemap + county borders show through
     *  the dense (opaque) core of the surface. */
    opacity: number
    weight: (c: StackedCell) => number
}

type MinimalViewState = { longitude: number; latitude: number; zoom: number }

/** The parent tile (one zoom up) that a tile's cells are fetched with. */
export function parentTile({ z, x, y }: Tile): Tile {
    return { z: z - 1, x: x >> 1, y: y >> 1 }
}

/** The distinct parent tiles of `tiles`, in first-seen order. */
export function fetchTiles(tiles: Tile[]): Tile[] {
    const seen = new Map<string, Tile>()
    for (const t of tiles) {
        const p = parentTile(t)
        const k = tileKey(p)
        if (!seen.has(k)) seen.set(k, p)
    }
    return [...seen.values()]
}

/** `prev` while `next` is within a factor `sticky` of it (so small changes in the visible tile
 *  set don't re-colorize every cached tile), else `next`. */
export function stickyVmax(prev: number | null, next: number, sticky = VMAX_STICKY): number {
    if (prev === null || !(prev > 0)) return next
    return next <= prev * sticky && next >= prev / sticky ? prev : next
}

/** `/v1/cells` URL for a parent tile's lean table (null: the scope polygon misses the tile). */
export function tileUrl(
    tile: Tile,
    level: number,
    filter: HeatTileFilter,
    groupYear: boolean,
    fullYears: [number, number],
): string | null {
    const padded = padBounds(tileToBounds(tile.z, tile.x, tile.y), FETCH_MARGIN_FRAC)
    const [w, s, e, n] = padded
    let poly: [number, number][] = [[w, n], [e, n], [e, s], [w, s], [w, n]]
    if (filter.clipPolygon && filter.clipPolygon.length >= 3) {
        poly = clipPolygonToBbox(filter.clipPolygon, padded)
        if (poly.length < 3) return null
    }
    const params = new URLSearchParams({
        cells: SHARDS,
        res: String(level),
        maxCells: String(MAX_CELLS),
        polygon: encodePolygon(poly),
        ...leanParams(groupYear, filter.yearRange, fullYears, filter.severities),
    })
    return `${CELLS_API_BASE}/v1/cells?${params}`
}

/** Density grids per (parent table → bake key). Keyed weakly by table, so they go when the
 *  lean cache evicts it. */
const gridCache = new WeakMap<LeanTable, Map<string, DensityGrid | null>>()
const GRIDS_PER_TABLE = 64
/** Colorized images per grid (one `vmax` / look at a time). */
const imageCache = new WeakMap<DensityGrid, { key: string; image: ImageData }>()

function cachedGrid(table: LeanTable, key: string, make: () => DensityGrid | null): DensityGrid | null {
    let m = gridCache.get(table)
    if (!m) { m = new Map(); gridCache.set(table, m) }
    if (m.has(key)) return m.get(key)!
    const g = make()
    if (m.size >= GRIDS_PER_TABLE) m.delete(m.keys().next().value as string)
    m.set(key, g)
    return g
}

type BakedTile = { id: string; image: ImageData; bounds: Bounds }

/** Build the baked `BitmapLayer`s for the current viewport under strategy C. */
export function useHeatTiles(
    enabled: boolean,
    viewState: MinimalViewState,
    container: { width: number; height: number },
    filter: HeatTileFilter | null,
    opts: HeatTileRenderOpts,
): BitmapLayer[] {
    const [tiles, setTiles] = useState<BakedTile[]>([])
    const runIdRef = useRef(0)
    const vmaxRef = useRef<{ key: string; vmax: number } | null>(null)
    const [manifest, setManifest] = useState<{ year_range: [number, number]; capabilities?: string[] } | null>(null)
    useEffect(() => {
        if (!enabled || manifest) return
        let cancelled = false
        loadManifest().then(m => { if (!cancelled) setManifest(m) }).catch(() => {})
        return () => { cancelled = true }
    }, [enabled, manifest])

    // Snap zoom to the tile level + round the center so small pans within a tile
    // set don't re-fire; a settle debounce is applied in the effect.
    const tileZ = enabled ? clampZ(round(viewState.zoom)) : 0
    const centerKey = enabled
        ? `${viewState.longitude.toFixed(3)},${viewState.latitude.toFixed(3)},${viewState.zoom.toFixed(2)}`
        : ""
    const sevKey = filter ? [...filter.severities].sort().join("") : ""
    const yearKey = filter ? `${filter.yearRange[0]}-${filter.yearRange[1]}` : ""
    const clipKey = filter?.clipPolygon ? encodePolygon(filter.clipPolygon) : ""

    useEffect(() => {
        if (!enabled || !filter || !manifest || container.width === 0) { setTiles([]); return }
        const runId = ++runIdRef.current
        const run = async () => {
            const level = clampS2Level(pickS2LevelForPixels(opts.cellPxTarget, tileZ, viewState.latitude))
            // Bake each tile at its on-screen device-pixel size. A level-`tileZ`
            // tile draws at 512·2^(zoom−tileZ) CSS px, ×dpr device px — rounded up to a half
            // power of two, so small zooms keep the cached bakes.
            const dpr = min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1)
            const displayPx = 512 * pow(2, viewState.zoom - tileZ) * dpr
            const tilePx = min(TILE_PX_CAP, max(TILE_PX_MIN, round(pow(2, ceil(2 * Math.log2(displayPx)) / 2))))
            const vp = new WebMercatorViewport({
                width: container.width, height: container.height,
                longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom,
            })
            // deck's `getBounds()` → flat [west, south, east, north].
            const [w, s, e, n] = vp.getBounds() as unknown as [number, number, number, number]
            const visible = tilesForBounds([w, s, e, n], tileZ)
            const groupYear = !!manifest.capabilities?.includes("group_year")
            const parents = fetchTiles(visible)
            const tables = new Map<string, LeanTable | null>()
            await Promise.all(parents.map(async p => {
                const url = tileUrl(p, level, filter, groupYear, manifest.year_range)
                const table = url ? await fetchLean(url).then(r => r.table).catch(() => null) : null
                tables.set(tileKey(p), table)
            }))
            if (runId !== runIdRef.current) return
            const perf = new URLSearchParams(location.search).get("perf") === "1"
            const t0 = perf ? performance.now() : 0

            // Two-pass bake: splat every tile over its own core bounds (memoized), then colorize
            // all against the shared `vmax` so brightness is consistent.
            const aggKey = `${yearKey}:${sevKey}`
            let splats = 0
            const grids = visible.map(tile => {
                const table = tables.get(tileKey(parentTile(tile)))
                if (!table) return null
                const edgeMeters = S2_EDGE_METERS[table.res] ?? S2_EDGE_METERS[13]
                const bounds = tileToBounds(tile.z, tile.x, tile.y)
                // σ at the tile's own latitude (not the view's), so a pan doesn't change a cached
                // tile's bake key.
                const tileLat = (bounds[1] + bounds[3]) / 2
                const sigmaMeters = max(opts.sigmaPx * metersPerPixel(tileZ, tileLat), SIGMA_FLOOR_FRAC * edgeMeters)
                const key = `${tileKey(tile)}|${aggKey}|${sigmaMeters.toFixed(3)}|${tilePx}`
                return cachedGrid(table, key, () => {
                    splats++
                    const [mw, ms, me, mn] = padBounds(bounds, MARGIN_FRAC)
                    const cells = aggregateLeanTables([table], filter.yearRange, filter.severities)
                        .filter(({ center: [x, y] }) => x >= mw && x <= me && y >= ms && y <= mn)
                    if (!cells.length) return null
                    return splatDensity(cells, { sigmaMeters, weight: opts.weight, bounds, width: tilePx, height: tilePx })
                })
            })
            const q = densityQuantile(grids, VMAX_QUANTILE)
            if (q <= 0) { setTiles([]); return }
            // Sticky only within one level / zoom / filter; anything else renormalizes.
            const vmaxKey = `${tileZ}|${level}|${aggKey}|${opts.sigmaPx}`
            const prev = vmaxRef.current?.key === vmaxKey ? vmaxRef.current.vmax : null
            const vmax = stickyVmax(prev, q)
            vmaxRef.current = { key: vmaxKey, vmax }

            const look = `${vmax}|${opts.floor}|${opts.colormap}|${opts.gamma}|${opts.alphaKnee}`
            let colorized = 0
            const baked: BakedTile[] = []
            for (let i = 0; i < visible.length; i++) {
                const g = grids[i]
                if (!g) continue
                let hit = imageCache.get(g)
                if (!hit || hit.key !== look) {
                    colorized++
                    hit = { key: look, image: colorizeDensity(g, { colormap: opts.colormap, gamma: opts.gamma, alphaKnee: opts.alphaKnee, vmax, floor: opts.floor }) }
                    imageCache.set(g, hit)
                }
                baked.push({ id: tileKey(visible[i]), image: hit.image, bounds: g.bounds })
            }
            if (perf) {
                const w = window as unknown as { __crashMapDebug?: Record<string, number> }
                w.__crashMapDebug = {
                    ...(w.__crashMapDebug ?? {}),
                    heatCTiles: baked.length,
                    heatCSplats: (w.__crashMapDebug?.heatCSplats ?? 0) + splats,
                    heatCColorized: (w.__crashMapDebug?.heatCColorized ?? 0) + colorized,
                }
                console.log(`[perf] heatC: zoom=${viewState.zoom.toFixed(2)} tileZ=${tileZ} level=l${level} tilePx=${tilePx} tiles=${visible.length} fetch=${parents.length} splat=${splats} colorize=${colorized} bake=${(performance.now() - t0).toFixed(0)}ms`)
            }
            setTiles(prevTiles => sameTiles(prevTiles, baked) ? prevTiles : baked)
        }
        const t = setTimeout(() => { run().catch(() => {}) }, SETTLE_MS)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, manifest, tileZ, centerKey, sevKey, yearKey, clipKey, container.width, container.height, opts.sigmaPx, opts.cellPxTarget, opts.floor])

    return useMemo(
        () => tiles.map(t => new BitmapLayer({ id: `heat-c-${t.id}`, image: t.image, bounds: t.bounds, opacity: opts.opacity })),
        [tiles, opts.opacity],
    )
}

function sameTiles(a: BakedTile[], b: BakedTile[]): boolean {
    return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.image === b[i].image)
}

/** Clamp the tile-pyramid zoom to a sane range (NJ statewide ≈ z7, street ≈ z18). */
function clampZ(z: number): number {
    return max(6, min(18, z))
}
