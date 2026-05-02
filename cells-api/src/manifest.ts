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

export type Manifest = {
    schema_version: number
    data_version: string
    base_res: number
    shard_res: number
    pyramid_levels: number[]
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
