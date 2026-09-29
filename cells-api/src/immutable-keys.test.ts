/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type CellsRequest, handleCellsRequest } from "./cells"
import {
    type Manifest,
    MANIFEST_TTL_MS,
    _resetManifestCache,
    d1Table,
    loadD1Version,
    loadManifest,
    pyramidShardKey,
    servingVersion,
} from "./manifest"
import { _resetFooterCache } from "./parquet"

/** Schema-6 manifests: content-hashed shard keys resolved through the
 *  manifest (specs/cells-immutable-keys.md), with the legacy fixed-name
 *  layout still readable. */

const LEGACY: Manifest = {
    schema_version: 5, data_version: "2026-09-27T23:36:35Z-e710a3c5027",
    pyramid_levels: [15], year_range: [2001, 2025], shard_cells: ["89b", "89d"],
}
const V6: Manifest = {
    ...LEGACY,
    schema_version: 6,
    data_version: "s2-bce081312bad",
    shards: {
        "s2_l15/89b": { key: "s2_pyramid/s2_l15/89b.0123456789ab.parquet" },
        "s2_l15/89d": { key: "s2_pyramid/s2_l15/89d.dd93aba96f30.parquet" },
    },
    d1: { table_prefix: "cells_s2_v7_l" },
}

describe("pyramidShardKey", () => {
    it("resolves a slot through the manifest's shards map", () => {
        expect([
            pyramidShardKey(V6, "cells", 15, "89d"),
            pyramidShardKey(V6, "cells", 15, "89c"),
            pyramidShardKey(V6, "cells", 16, "89d"),
        ]).toEqual(["cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet", null, null])
    })

    it("falls back to the fixed-name layout for a legacy manifest", () => {
        expect(pyramidShardKey(LEGACY, "cells-e710a3c", 15, "89d")).toBe("cells-e710a3c/s2_pyramid/s2_l15/89d.parquet")
    })
})

describe("d1Table", () => {
    it("uses the manifest's table prefix, defaulting to cells_s2_l", () => {
        expect([d1Table(V6, 13), d1Table(LEGACY, 13)]).toEqual(["cells_s2_v7_l13", "cells_s2_l13"])
    })

    it("refuses a prefix that isn't a bare identifier", () => {
        expect(() => d1Table({ ...V6, d1: { table_prefix: "x; DROP TABLE y; --" } }, 13))
            .toThrow("bad d1.table_prefix in manifest: x; DROP TABLE y; --")
    })
})

/** R2 fake serving `manifest.json` from a mutable slot, counting reads. */
function manifestBucket(initial: Manifest | Error) {
    const state = { current: initial as Manifest | Error, gets: 0 }
    const bucket = {
        async get(key: string) {
            expect(key).toBe("cells/manifest.json")
            state.gets++
            if (state.current instanceof Error) throw state.current
            const text = JSON.stringify(state.current)
            return { async text() { return text } }
        },
    } as unknown as R2Bucket
    return { bucket, state }
}

describe("loadManifest TTL", () => {
    beforeEach(() => _resetManifestCache())
    const T = 1_000_000

    it("re-reads after the TTL, so a cutover propagates without a deploy", async () => {
        const { bucket, state } = manifestBucket(LEGACY)
        expect((await loadManifest(bucket, "cells", T)).data_version).toBe(LEGACY.data_version)
        state.current = V6
        expect((await loadManifest(bucket, "cells", T + MANIFEST_TTL_MS - 1)).data_version).toBe(LEGACY.data_version)
        expect((await loadManifest(bucket, "cells", T + MANIFEST_TTL_MS)).data_version).toBe(V6.data_version)
        expect(state.gets).toBe(2)
    })

    it("keeps serving the cached manifest when a refresh fails", async () => {
        const { bucket, state } = manifestBucket(V6)
        await loadManifest(bucket, "cells", T)
        state.current = new Error("R2 down")
        expect((await loadManifest(bucket, "cells", T + MANIFEST_TTL_MS)).data_version).toBe(V6.data_version)
        expect(state.gets).toBe(2)
    })

    it("doesn't cache a failed first load", async () => {
        const { bucket, state } = manifestBucket(new Error("R2 down"))
        await expect(loadManifest(bucket, "cells", T)).rejects.toThrow("R2 down")
        state.current = V6
        expect((await loadManifest(bucket, "cells", T + 1)).data_version).toBe(V6.data_version)
    })
})

describe("serving version (ETag / edge-cache salt)", () => {
    beforeEach(() => _resetManifestCache())

    function d1(result: () => Array<{ source_md5: string }>) {
        const sqls: string[] = []
        const db = {
            prepare(sql: string) {
                sqls.push(sql)
                return { async all() { return { results: result() } } }
            },
        } as unknown as D1Database
        return { db, sqls }
    }

    it("folds D1's import stamp into the version", async () => {
        const { db, sqls } = d1(() => [{ source_md5: "b703518dd85c79fcb52ab040aeebb8cc" }])
        const v = await loadD1Version(db, 0)
        expect([v, servingVersion(V6, v), sqls]).toEqual([
            "b703518dd85c79fcb52ab040aeebb8cc",
            "s2-bce081312bad+d1.b703518dd85c",
            ["SELECT source_md5 FROM _metadata LIMIT 1"],
        ])
        await loadD1Version(db, MANIFEST_TTL_MS - 1)
        expect(sqls.length).toBe(1)
    })

    it("degrades to data_version alone without D1 or its stamp", async () => {
        const { db } = d1(() => { throw new Error("no such table: _metadata") })
        expect([await loadD1Version(undefined), await loadD1Version(db, 0), servingVersion(V6, "")])
            .toEqual(["", "", "s2-bce081312bad"])
    })
})

const PYRAMID_ROOT = resolve(__dirname, "../../data/cells")
const HAVE_PYRAMID = existsSync(`${PYRAMID_ROOT}/s2_pyramid/s2_l15/89d.parquet`)
    && existsSync(`${PYRAMID_ROOT}/s2_pyramid/s2_l15/89b.parquet`)

/** R2 fake over the local pyramid: `keys` maps an R2 key to a local relpath;
 *  anything else is absent. Records every key read. */
function pyramidBucket(manifest: Manifest, keys: Record<string, string>) {
    const read: string[] = []
    const bucket = {
        async head(key: string) {
            return key in keys ? { size: readFileSync(`${PYRAMID_ROOT}/${keys[key]}`).length } : null
        },
        async get(key: string, opts?: { range?: { offset: number; length: number } }) {
            if (key === "cells/manifest.json") return { async text() { return JSON.stringify(manifest) } }
            if (!(key in keys)) return null
            read.push(key)
            const buf = readFileSync(`${PYRAMID_ROOT}/${keys[key]}`)
            const off = opts?.range?.offset ?? 0
            const slice = buf.subarray(off, off + (opts?.range?.length ?? buf.length - off))
            return { async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) } }
        },
    } as unknown as R2Bucket
    return { bucket, read }
}

describe.skipIf(!HAVE_PYRAMID)("pyramid reads through hashed keys", () => {
    beforeEach(() => { _resetManifestCache(); _resetFooterCache() })

    /** ~850×780 m box around Journal Square, Jersey City. */
    const JSQ: [number, number][] = [[-74.0680, 40.7370], [-74.0580, 40.7370], [-74.0580, 40.7300], [-74.0680, 40.7300]]
    const REQ: CellsRequest = { cells: ["89b", "89d"], res: 15, yearRange: [2015, 2022], clipPolygon: JSQ, labels: "nums" }

    it("serves the same cells as the fixed-name layout, reading only manifest keys", async () => {
        const legacy = pyramidBucket(LEGACY, {
            "cells/s2_pyramid/s2_l15/89b.parquet": "s2_pyramid/s2_l15/89b.parquet",
            "cells/s2_pyramid/s2_l15/89d.parquet": "s2_pyramid/s2_l15/89d.parquet",
        })
        const expected = await handleCellsRequest(legacy.bucket, "cells", REQ)

        _resetManifestCache(); _resetFooterCache()
        const hashed = pyramidBucket(V6, {
            "cells/s2_pyramid/s2_l15/89b.0123456789ab.parquet": "s2_pyramid/s2_l15/89b.parquet",
            "cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet": "s2_pyramid/s2_l15/89d.parquet",
        })
        const actual = await handleCellsRequest(hashed.bucket, "cells", REQ)
        expect(actual).toEqual({ ...expected, data_version: V6.data_version })
        expect([...new Set(hashed.read)].sort()).toEqual([
            "cells/s2_pyramid/s2_l15/89b.0123456789ab.parquet",
            "cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet",
        ])
    })

    it("skips a slot the manifest doesn't list (an empty shard)", async () => {
        const only89d: Manifest = { ...V6, shards: { "s2_l15/89d": V6.shards!["s2_l15/89d"] } }
        const { bucket, read } = pyramidBucket(only89d, {
            "cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet": "s2_pyramid/s2_l15/89d.parquet",
        })
        await handleCellsRequest(bucket, "cells", REQ)
        expect([...new Set(read)]).toEqual(["cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet"])
    })

    it("uses the manifest passed in, not a fresher one in R2 (one build per request)", async () => {
        const { bucket } = pyramidBucket(LEGACY, {
            "cells/s2_pyramid/s2_l15/89b.0123456789ab.parquet": "s2_pyramid/s2_l15/89b.parquet",
            "cells/s2_pyramid/s2_l15/89d.dd93aba96f30.parquet": "s2_pyramid/s2_l15/89d.parquet",
        })
        const r = await handleCellsRequest(bucket, "cells", REQ, undefined, undefined, V6)
        expect([r.data_version, "cells" in r && r.cells.length > 0]).toEqual([V6.data_version, true])
    })
})

describe("D1 table from the manifest", () => {
    beforeEach(() => _resetManifestCache())

    it("queries this build's table set", async () => {
        const sqls: string[] = []
        const db = {
            prepare(sql: string) { sqls.push(sql); return { async all() { return { results: [] } } } },
        } as unknown as D1Database
        const { bucket } = pyramidBucket(V6, {})
        await handleCellsRequest(bucket, "cells", { cells: ["89d"], res: 13, labels: "nums" }, db)
        expect(sqls).toEqual([
            "SELECT cellid, n_fatal, n_inj_ped, n_inj_other, n_pdo, n_vehs, n_killed, n_killed_ped, fatal_years FROM cells_s2_v7_l13 WHERE (cellid BETWEEN '89c00004' AND '89dffffc')",
        ])
    })
})
