/** Heatmap render strategy C (`?hr=c`) — a mercator-tile pyramid of baked KDE
 *  surfaces.
 *
 *  Each visible tile is fetched independently (`/v1/cells` narrowed to the
 *  tile's bbox + a margin), baked at its own zoom (so the raster is always
 *  ~screen-resolution — fixing A's blur when zoomed into a coarse single bake),
 *  and drawn as a `BitmapLayer`. Two things make the tiling seamless:
 *    - **kernel bleed:** each tile fetches a margin of neighbor cells, and its
 *      bake grid is the *core* tile bbox, so a neighbor cell's Gaussian tail
 *      contributes to the edge without the tile drawing outside its bounds
 *      (adjacent core grids tile exactly — no gaps, no double-draw).
 *    - **shared normalization:** all visible tiles colorize against one `vmax`
 *      (the max density across them), so there's no brightness seam at a density
 *      gradient (the reason a naive per-tile normalize looks tiled).
 *
 *  Fetches are cached per (tile, level, filter), so a pan reuses already-loaded
 *  tiles and only the newly-exposed ones hit the network — deck.gl `TileLayer`'s
 *  cache behavior, done by hand to avoid the `@deck.gl/geo-layers` dependency
 *  (its luma.gl peer range conflicts with our pinned deck stack).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { BitmapLayer } from "@deck.gl/layers"
import { WebMercatorViewport } from "@deck.gl/core"
import { tokenCenterLngLat, pickS2LevelForPixels, clampS2Level, S2_EDGE_METERS } from "./s2"
import { CELLS_API_BASE } from "./config"
import { splatDensity, colorizeDensity, type Bounds } from "./bakeDensity"
import type { StackedCell } from "./StackedCellLayer"
import type { ColormapName } from "./colormap"
import { tilesForBounds, tileToBounds, padBounds, tileKey, type Tile } from "./tileMath"

const { round, min, max, ceil, pow } = Math

/** Each tile is baked at its *displayed* device-pixel size so the `BitmapLayer`
 *  never up-samples (which is what made a fixed 256px bake look blurry): a
 *  mercator tile at its native zoom draws at 512 CSS px — ×devicePixelRatio
 *  device px (2× on retina). We size the grid to that, clamped to [MIN, CAP] to
 *  bound the CPU splat/colorize cost. */
const TILE_PX_MIN = 256
const TILE_PX_CAP = 1024
/** Fraction of the tile span fetched as margin on each side, for kernel bleed. */
const MARGIN_FRAC = 0.3
const SHARDS = "89b,89d"
const MAX_CELLS = 150_000

export type HeatTileFilter = {
    yearRange: [number, number]
    severities: Set<"f" | "i" | "p">
    clipPolygon?: [number, number][] | null
}

export type HeatTileRenderOpts = {
    colormap: ColormapName
    gamma: number
    alphaKnee: number
    /** Kernel σ as a fraction of the S2 cell edge (world meters). */
    sigmaFrac: number
    /** Target cell size (px) fed to the S2-level picker. */
    cellPxTarget: number
    /** Layer opacity (0–1). <1 lets the basemap + county borders show through
     *  the dense (opaque) core of the surface. */
    opacity: number
    weight: (c: StackedCell) => number
}

type MinimalViewState = { longitude: number; latitude: number; zoom: number }

type CellOutRow = {
    cellid: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
}

/** Module-scoped per-(tile,level,filter) cell cache — survives remounts. */
const tileCache = new Map<string, Promise<StackedCell[]>>()

function encodePolygon([w, s, e, n]: Bounds): string {
    const f = (x: number) => x.toFixed(4)
    return [w, n, e, n, e, s, w, s, w, n].map(f).join(",")
}

function fetchTileCells(tile: Tile, level: number, filter: HeatTileFilter): Promise<StackedCell[]> {
    const sevs = ["f", "i", "p"].filter(c => filter.severities.has(c as "f" | "i" | "p")).join("")
    const key = `${tileKey(tile)}|${level}|${filter.yearRange[0]}-${filter.yearRange[1]}|${sevs}`
    let p = tileCache.get(key)
    if (p) return p
    const padded = padBounds(tileToBounds(tile.z, tile.x, tile.y), MARGIN_FRAC)
    const params = new URLSearchParams({
        cells: SHARDS,
        res: String(level),
        years: `${filter.yearRange[0]}-${filter.yearRange[1]}`,
        severities: sevs,
        maxCells: String(MAX_CELLS),
        labels: "nums",
        polygon: encodePolygon(padded),
    })
    p = fetch(`${CELLS_API_BASE}/v1/cells?${params}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`cells ${r.status}`)))
        .then((body: { cells: CellOutRow[] }) => {
            const out: StackedCell[] = []
            for (const c of body.cells) {
                const total = c.n_fatal + c.n_inj_ped + c.n_inj_other + c.n_pdo
                if (total === 0) continue
                out.push({
                    cellid: c.cellid,
                    center: tokenCenterLngLat(c.cellid),
                    fatal: c.n_fatal,
                    pedInj: c.n_inj_ped,
                    otherInj: c.n_inj_other,
                    pdo: c.n_pdo,
                    total,
                })
            }
            return out
        })
        .catch(err => { tileCache.delete(key); throw err })
    tileCache.set(key, p)
    return p
}

/** Build the baked `BitmapLayer`s for the current viewport under strategy C. */
export function useHeatTiles(
    enabled: boolean,
    viewState: MinimalViewState,
    container: { width: number; height: number },
    filter: HeatTileFilter | null,
    opts: HeatTileRenderOpts,
): BitmapLayer[] {
    const [tiles, setTiles] = useState<Array<{ id: string; image: ImageData; bounds: Bounds }>>([])
    const runIdRef = useRef(0)

    // Snap zoom to the tile level + round the center so small pans within a tile
    // set don't re-fire; a settle debounce is applied in the effect.
    const tileZ = enabled ? clampZ(round(viewState.zoom)) : 0
    const centerKey = enabled
        ? `${viewState.longitude.toFixed(3)},${viewState.latitude.toFixed(3)}`
        : ""
    const sevKey = filter ? [...filter.severities].sort().join("") : ""
    const yearKey = filter ? `${filter.yearRange[0]}-${filter.yearRange[1]}` : ""

    useEffect(() => {
        if (!enabled || !filter || container.width === 0) { setTiles([]); return }
        const runId = ++runIdRef.current
        const t = setTimeout(async () => {
            const level = clampS2Level(pickS2LevelForPixels(opts.cellPxTarget, tileZ, viewState.latitude))
            const sigmaMeters = (S2_EDGE_METERS[level] ?? S2_EDGE_METERS[13]) * opts.sigmaFrac
            // Bake each tile at its on-screen device-pixel size. A level-`tileZ`
            // tile draws at 512·2^(zoom−tileZ) CSS px, ×dpr device px.
            const dpr = min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1)
            const displayPx = 512 * pow(2, viewState.zoom - tileZ) * dpr
            const tilePx = min(TILE_PX_CAP, max(TILE_PX_MIN, ceil(displayPx)))
            const vp = new WebMercatorViewport({
                width: container.width, height: container.height,
                longitude: viewState.longitude, latitude: viewState.latitude, zoom: viewState.zoom,
            })
            // deck's `getBounds()` → flat [west, south, east, north].
            const [w, s, e, n] = vp.getBounds() as unknown as [number, number, number, number]
            const visible = tilesForBounds([w, s, e, n], tileZ)

            const cellsPerTile = await Promise.all(
                visible.map(tile => fetchTileCells(tile, level, filter).catch(() => [] as StackedCell[])),
            )
            if (runId !== runIdRef.current) return
            const perf = new URLSearchParams(location.search).get("perf") === "1"
            const t0 = perf ? performance.now() : 0

            // Two-pass bake: splat every tile over its own core bounds, then
            // colorize all against the shared max so brightness is consistent.
            const grids = visible.map((tile, i) => {
                const cells = cellsPerTile[i]
                if (!cells.length) return null
                return splatDensity(cells, {
                    sigmaMeters,
                    weight: opts.weight,
                    bounds: tileToBounds(tile.z, tile.x, tile.y),
                    width: tilePx,
                    height: tilePx,
                })
            })
            let vmax = 0
            for (const g of grids) if (g && g.localMax > vmax) vmax = g.localMax
            if (vmax <= 0) { if (runId === runIdRef.current) setTiles([]); return }

            const baked: Array<{ id: string; image: ImageData; bounds: Bounds }> = []
            for (let i = 0; i < visible.length; i++) {
                const g = grids[i]
                if (!g) continue
                baked.push({
                    id: tileKey(visible[i]),
                    image: colorizeDensity(g, { colormap: opts.colormap, gamma: opts.gamma, alphaKnee: opts.alphaKnee, vmax }),
                    bounds: g.bounds,
                })
            }
            if (perf) {
                const nCells = cellsPerTile.reduce((s, c) => s + c.length, 0)
                console.log(`[perf] heatC: zoom=${viewState.zoom.toFixed(2)} tileZ=${tileZ} level=l${level} σ=${sigmaMeters.toFixed(0)}m tilePx=${tilePx} tiles=${visible.length} cells=${nCells} bake=${(performance.now() - t0).toFixed(0)}ms`)
            }
            if (runId === runIdRef.current) setTiles(baked)
        }, 180)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, tileZ, centerKey, sevKey, yearKey, container.width, container.height, opts.sigmaFrac, opts.cellPxTarget])

    return useMemo(
        () => tiles.map(t => new BitmapLayer({ id: `heat-c-${t.id}`, image: t.image, bounds: t.bounds, opacity: opts.opacity })),
        [tiles, opts.opacity],
    )
}

/** Clamp the tile-pyramid zoom to a sane range (NJ statewide ≈ z7, street ≈ z18). */
function clampZ(z: number): number {
    return max(6, min(18, z))
}
