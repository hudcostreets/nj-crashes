/** Worker-side manifest cache + shard-key resolution.
 *
 *  The pipeline writes `${CELLS_PREFIX}/manifest.json` (`njdot compute cells
 *  push`; see `specs/cells-immutable-keys.md`). It carries the layout
 *  (base/shard level, pyramid levels, year_range), a `data_version` (ETag +
 *  edge-cache salt), and — from schema 6 — `shards`: each pyramid slot's
 *  content-hashed R2 key. `manifest.json` is the one mutable object; every
 *  key it names is immutable, so a push that rewrites it is an atomic
 *  cutover and never disturbs in-flight reads of the previous build.
 *
 *  Cached per isolate for `MANIFEST_TTL_MS`, then re-read, so a cutover (or
 *  rollback) propagates within a minute without a worker deploy. Callers
 *  load it once per request and pass it down, so one request never mixes two
 *  builds.
 */

/** Legacy H3-era multi-resolution combos (informational only). */
export type PyramidCombo = {
    shard_res: number
    data_res: number
    shard_count?: number
    shard_cells?: string[]
    row_count?: number
    byte_size?: number
}

/** One pyramid slot's published blob. */
export type ShardEntry = {
    /** Key relative to the cells root prefix, e.g.
     *  `s2_pyramid/s2_l21/89d.dd93aba96f30.parquet`. */
    key: string
    md5?: string
    bytes?: number
}

export type Manifest = {
    schema_version: number
    data_version: string
    base_level?: number
    shard_level?: number
    pyramid_levels: number[]
    /** Multi-resolution combos. Empty for schema_version < 4. */
    pyramid_combos?: PyramidCombo[]
    year_range: [number, number]
    shard_cells: string[]
    row_counts?: Record<string, number>
    /** Schema ≥ 6: slot (`s2_l{level}/{shard}`) → content-hashed key. Absent
     *  in the legacy fixed-name layout (`s2_pyramid/s2_l{L}/{shard}.parquet`). */
    shards?: Record<string, ShardEntry>
    key_template?: string
    /** D1 tables this build's all-years rollup lives in (`{table_prefix}{level}`). */
    d1?: { table_prefix?: string; source_md5?: string }
}

export const MANIFEST_TTL_MS = 60_000
export const D1_TABLE_PREFIX_DEFAULT = "cells_s2_l"

type Entry = { at: number; promise: Promise<Manifest> }
const cache = new Map<string, Entry>()

async function fetchManifest(bucket: R2Bucket, key: string): Promise<Manifest> {
    const obj = await bucket.get(key)
    if (!obj) throw new Error(`manifest missing at R2 key: ${key}`)
    return JSON.parse(await obj.text()) as Manifest
}

export function loadManifest(bucket: R2Bucket, prefix: string, now: number = Date.now()): Promise<Manifest> {
    const key = `${prefix}/manifest.json`
    const hit = cache.get(key)
    if (hit && now - hit.at < MANIFEST_TTL_MS) return hit.promise
    const promise = fetchManifest(bucket, key)
    if (hit) {
        // Refresh: keep serving the previous manifest if the re-read fails.
        const prev = hit.promise
        const refreshed = promise.catch(e => {
            console.error(`manifest refresh failed (${key}), keeping the cached one:`, e)
            return prev
        })
        cache.set(key, { at: now, promise: refreshed })
        return refreshed
    }
    cache.set(key, { at: now, promise })
    // Don't cache a failed first load.
    promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key) })
    return promise
}

/** R2 key of the pyramid shard for `(level, shard)`, or null when the
 *  manifest lists no such slot (an empty shard: nothing to read). */
export function pyramidShardKey(manifest: Manifest, prefix: string, level: number, shard: string): string | null {
    if (manifest.shards) {
        const entry = manifest.shards[`s2_l${level}/${shard}`]
        return entry ? `${prefix}/${entry.key}` : null
    }
    return `${prefix}/s2_pyramid/s2_l${level}/${shard}.parquet`
}

/** D1 table holding `level`'s all-years rollup for this build. The prefix
 *  comes from R2, so it's validated before being spliced into SQL. */
export function d1Table(manifest: Manifest, level: number): string {
    const prefix = manifest.d1?.table_prefix ?? D1_TABLE_PREFIX_DEFAULT
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`bad d1.table_prefix in manifest: ${prefix}`)
    return `${prefix}${level}`
}

/** D1's content stamp: `_metadata.source_md5`, written by every
 *  `api/scripts/d1-import.sh` run. D1 is refreshed on its own schedule (the
 *  daily in-place diff) while `data_version` only moves on an R2 push, so a
 *  cache keyed on `data_version` alone would serve pre-import D1 answers for
 *  the edge TTL (a week). Cached per isolate like the manifest; "" when the
 *  table is absent or the query fails (the key then degrades to
 *  `data_version` alone, as before). */
let d1Cache: { at: number; promise: Promise<string> } | null = null

export function loadD1Version(db: D1Database | undefined, now: number = Date.now()): Promise<string> {
    if (!db) return Promise.resolve("")
    if (d1Cache && now - d1Cache.at < MANIFEST_TTL_MS) return d1Cache.promise
    const promise = db.prepare("SELECT source_md5 FROM _metadata LIMIT 1").all<{ source_md5: string }>()
        .then(r => r.results?.[0]?.source_md5 ?? "")
        .catch(e => { console.error("D1 _metadata read failed:", e); return "" })
    d1Cache = { at: now, promise }
    return promise
}

/** The version a `/v1/cells` response's ETag + edge-cache key are salted
 *  with: the R2 build, plus the D1 import it may have been served from. */
export function servingVersion(manifest: Manifest, d1Version: string): string {
    return d1Version ? `${manifest.data_version}+d1.${d1Version.slice(0, 12)}` : manifest.data_version
}

/** Test-only: clear the in-memory manifest (and D1-version) caches. */
export function _resetManifestCache(): void {
    cache.clear()
    d1Cache = null
}
