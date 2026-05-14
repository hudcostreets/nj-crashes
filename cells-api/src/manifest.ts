/** Worker-side manifest cache.
 *
 *  The pipeline writes `manifest.json` at the bucket root (see
 *  `specs/cfw-cells-pipeline.md` Phase 3). It carries the bucket layout
 *  (base_res, shard_res, pyramid_levels, shard list, year_range) and a
 *  content-addressed `data_version` we use as part of the worker's ETag
 *  + cache key.
 *
 *  Loaded once at cold start, refreshed lazily on cache miss.
 */

/** A pre-aggregated `(shard_res, data_res)` slice of the pyramid. Each
 *  combo lives at `pyramid/s{shard_res}_r{data_res}/{shard_cell}.parquet`
 *  with `shard_cell` an H3 hex at `shard_res`. Clients pick the combo
 *  whose viewport-shard-count falls in a target range. */
export type PyramidCombo = {
    shard_res: number
    data_res: number
    shard_cells: string[]
    row_count?: number
    byte_size?: number
}

export type Manifest = {
    schema_version: number
    data_version: string
    base_res: number
    shard_res: number
    pyramid_levels: number[]
    /** Multi-resolution combos. Empty for schema_version < 4. */
    pyramid_combos?: PyramidCombo[]
    year_range: [number, number]
    shard_cells: string[]
    row_counts?: Record<string, number>
}

let cached: Promise<Manifest> | null = null

export function loadManifest(bucket: R2Bucket, prefix: string): Promise<Manifest> {
    if (cached) return cached
    const key = `${prefix}/manifest.json`
    cached = (async () => {
        const obj = await bucket.get(key)
        if (!obj) throw new Error(`manifest missing at R2 key: ${key}`)
        const text = await obj.text()
        const m = JSON.parse(text) as Manifest
        return m
    })()
    return cached
}

/** Test-only: clear the in-memory manifest cache. */
export function _resetManifestCache(): void {
    cached = null
}
