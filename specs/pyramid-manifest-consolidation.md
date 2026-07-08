# Pyramid manifest + per-res layout consolidation

Follows `specs/done/pyramid-rowgroup-consolidation.md`. That consolidation
went from 336k files → 340 by dropping the fine-tier shards; this one
takes the next step: **kill the per-request footer-fetch cost, tune
file+row-group sizing per res, and hand the worker a manifest so it
does one range-read per required row-group and nothing else.**

## Target

**p95 wide-vp `/cells` < 500 ms.** Deep-zoom < 200 ms. Bytes on the wire
unchanged; the win is entirely worker-CPU + IO round-trips.

Measured baseline (2026-07-08, z=8.46 statewide, `?bins=100000`):

| bytes on wire (gzip) | wall-clock | source |
|---|---|---|
| ~500 KB (r8) | **6.3 s** (95th) | 25 r4-shard files × footer fetch + parse + decode |

## Root cause

At wide zoom the worker fans out over 25–34 r4 shard files. Per-file
overhead compounds:

- **Footer fetch + parse** — ~264 KB footer × N files → 6–8 MB of footer
  bytes + N hyparquet-JS parse loops. On CFW's single V8 thread this
  serializes (R2 IO can parallelize, decode can't).
- **RG walk** — each file's RG index is walked to decide which RGs to
  read. In the current pruning path we `$or` the h3-descendant ranges of
  the viewport cover; at wide zoom the ranges cover the whole shard, so
  every RG is decoded.
- **Aggregate + serialize** — merging ~66k cells into one output map +
  JSON.stringify.

The gzipped body is 3 MB → wire time is ~50 ms. The rest of the ~6 s is
CPU. Consolidating to fewer files + baking footer info into a manifest
eliminates ~90% of that CPU.

## Design

### Layout: per-res file count + row-group sizing

Neither "one file per r4 shard" (current: 34) nor "one file total" is
right at every res. Split by size:

| data_res | rows in NJ (est) | files | rows/RG | RGs/file | notes |
|---|---:|---:|---:|---:|---|
| r6  | ~250 | **1** | all | 1 | trivially small; wide-vp decodes everything |
| r7  | ~1k  | **1** | all | 1 |  |
| r8  | ~9k  | **1** | 2k  | ~5 |  |
| r9  | ~40k | **1** | 3k  | ~15 | tight-vp starts pruning |
| r10 | ~150k | **1** | 5k  | ~30 |  |
| r11 | ~500k | **1** | 5k  | ~100 | wide-vp reads all RGs, but a big file's overhead isn't per-RG here |
| r12 | ~1.5M | **2** (r1-sharded) | 5k  | ~150/file |  |
| r13 | ~5M   | **4** (r2-sharded, coarse) | 5k  | ~250/file |  |
| r14 | ~15M  | **8** (r2-sharded) | 5k  | ~375/file |  |
| r15 | ~40M  | **16** (r2-sharded) | 5k  | ~500/file | current 34 (r4) also fine; keep whichever the build tools prefer |

Row counts are estimates from the current pyramid; **`e` should verify
against real data before finalizing** — the file / RG counts follow from
the row counts by holding `rows/RG ≈ 5000` (empirical sweet spot for
hyparquet decode: ~5–20 ms per RG) and keeping `RGs/file ≤ ~500` so RG
walks stay quick even without stats prune.

**Sharding key.** At r13–r15 use r2 cells (~8 across NJ area) as shards
rather than r4 (~34) — a wider viewport typically spans fewer r2 cells
than r4, so fanout stays under ~8 even at wide-vp queries at fine res
(rare, but bounded).

**Row-group boundaries.** Cells are h3-sorted globally within each file.
RG boundaries align to h3-index ranges so stats prune is effective at
tight-vp queries. RG size ≈ 5k rows is a target, not a hard cutoff —
whatever the pyramid builder produces from a natural h3 chunking is
fine as long as no RG is >20k rows or <500.

**File-size ballpark** (rows × ~110 B/row compressed):

- r6–r10: <20 MB per file
- r11–r15: 50–200 MB per file

All well within hyparquet-JS's comfort zone (range reads mean only the
requested RGs materialize).

### Manifest

**One JSON file** at `cells/manifest.v3.json`, **also embedded into the
worker bundle at deploy time** so the "manifest fetch" cost is zero.
Ships with each worker deploy.

**Schema:**

```jsonc
{
  "schema_version": 3,
  "data_version": "2026-07-08T00:43:57Z-45aaf3f7e16",
  "year_range": [2001, 2025],
  "base_res": 15,
  "pyramid_levels": [6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  "levels": {
    "6": {
      "shard_res": null,                       // one file total
      "files": [
        {
          "key": "cells/pyramid/r6.parquet",
          "size": 3421,
          "shard_h3": null,                    // whole NJ
          "row_groups": [
            {
              "h3_min": 617700169958129663,    // big-endian uint64 for range comparisons
              "h3_max": 617700290597568511,
              "byte_offset": 4,                // where the RG's row-column data starts
              "byte_length": 2103,             // bytes to fetch
              "rows": 253,
              "cols": {                        // column-level offsets for projection
                "h3": {"offset": 4,    "length": 512},
                "n_fatal": {"offset": 516,  "length": 128},
                "n_inj_ped": {"offset": 644,  "length": 128},
                "n_inj_other": {"offset": 772,  "length": 128},
                "n_pdo": {"offset": 900,  "length": 128},
                "n_vehs": {"offset": 1028, "length": 128},
                "sld_name": {"offset": 1156, "length": 400},
                "cross_sld_name": {"offset": 1556, "length": 400},
                "mun": {"offset": 1956, "length": 100},
                "county": {"offset": 2056, "length": 47}
              }
            }
          ]
        }
      ]
    },
    "12": {
      "shard_res": 1,
      "files": [
        {"key": "cells/pyramid/r12/821203fffffffff.parquet", "shard_h3": "821203fffffffff", "size": 51_234_567, "row_groups": [...]},
        {"key": "cells/pyramid/r12/821207fffffffff.parquet", "shard_h3": "821207fffffffff", "size": 62_345_678, "row_groups": [...]}
      ]
    }
  }
}
```

**Rationale for column-level offsets.** Lets the worker read exactly the
columns the client asked for (many `/cells` responses don't need
`sld_name`/`mun`/`county` — the map layer at wide zoom just aggregates
counts, not labels). Cutting projection bytes ~2× on the common path.
Optional in a v1: worker can fall back to whole-RG reads if `cols` is
absent.

**Sizing:** ~200 KB uncompressed at r6–r10, ~1–3 MB total including
r11–r15. Baked into the worker bundle (CFW's 1 MB compressed bundle
limit → manifest goes into a separate module chunk if needed, but
uncompressed 3 MB gzips to well under 1 MB).

**Query semantics.** The worker's cache-key stays `(polygon, res,
years, severities)`. Data-version invalidation is implicit via bundle
redeploy — a new manifest = a new deploy = new worker version, so
in-flight requests aren't split across data versions.

### Worker code path

Replace `queryPyramid` (`cells-api/src/cells.ts`) with a manifest-driven
path:

```ts
// One-time at module load: import the baked manifest
import manifest from "./manifest.v3.json"

async function queryPyramid(req: CellsRequest): Promise<CellsResponse> {
    const level = manifest.levels[req.res]
    if (!level) throw new HttpError(400, `res ${req.res} not in pyramid`)

    // 1. Compute h3 range from viewport cover — same code as today
    const ranges = mergeRanges(req.cells.map(c =>
        descendantRange(hexToBigint(c), getResolution(c), req.res)))

    // 2. Match ranges against manifest RG stats. Pick RGs whose h3_min/max
    //    intersect any query range. No footer fetch, no parquet parse.
    const hits: RGRef[] = []
    for (const file of level.files) {
        for (const rg of file.row_groups) {
            if (rangesIntersect(ranges, rg)) {
                hits.push({ file, rg })
            }
        }
    }

    // 3. Fire concurrent range GETs — one per RG. R2 binding parallelizes
    //    across files; multiple RGs in the same file dedupe against the
    //    RG's byte_offset..byte_length span.
    const rgBytes = await Promise.all(hits.map(h =>
        bucket.get(h.file.key, {
            range: { offset: h.rg.byte_offset, length: h.rg.byte_length }
        }).then(r => r!.arrayBuffer())
    ))

    // 4. Decode each RG's bytes with hyparquet (no metadata parse — the
    //    manifest carries what hyparquet would otherwise read from the
    //    footer). See "Decoding without footer" below.
    const rows = rgBytes.flatMap((buf, i) => decodeRG(buf, hits[i].rg, req))

    // 5. Filter (year, severity, polygon) + aggregate + serialize — same
    //    as today.
    return aggregate(rows, req)
}
```

**"Decoding without footer".** hyparquet-JS's public API expects a full
parquet file; using it for a bare RG requires either (a) reconstructing
a minimal footer envelope around the RG bytes in memory, or (b) using
its lower-level column-decode functions directly (they exist but aren't
part of the ergonomic API). Either works; (a) is ~10 lines of code and
reuses the existing decode path. Prototype path: fetch the whole file
into an `asyncBuffer` that lies about the file bounds so hyparquet
reads only the requested RG. `e` — verify with hyparquet maintainers /
source that this is stable.

Fallback if the above turns out ugly: fetch **whole file** (still one
range read, still no footer download because manifest carries it) and
let hyparquet skip past uninteresting RGs via its stats. That's a mild
regression on IO but zero code churn.

### Multi-range HTTP

Skip. RFC 7233 §4.1 multipart/byteranges works over R2's public HTTP
API but not the CFW R2 binding. Concurrent single-range binding calls
parallelize fine at N ≤ 20; the wall-clock win from batching would be
<50 ms and the code cost is significant. Revisit if RGs ever get very
numerous.

### Client changes

**None.** Same `/v1/cells` endpoint, same request shape, same response
shape. All wins land at the worker.

## Generator

New CLI subcommand: `njdot compute cells manifest`.

```bash
env -u PYTHONPATH njdot compute cells manifest \
    --pyramid-dir data/cells/pyramid \
    --out cells-api/manifest.v3.json
```

**Implementation** (Python, using `pyarrow`):

```python
import pyarrow.parquet as pq
import json

def build_manifest(pyramid_dir, levels, data_version):
    m = {"schema_version": 3, "data_version": data_version, "levels": {}}
    for res in levels:
        files = []
        for parquet_path in sorted(pyramid_dir.glob(f"r{res}/*.parquet")):
            pf = pq.ParquetFile(str(parquet_path))
            rgs = []
            for rg_idx in range(pf.num_row_groups):
                rg_meta = pf.metadata.row_group(rg_idx)
                h3_col = rg_meta.column(pf.schema_arrow.get_field_index("h3"))
                rgs.append({
                    "h3_min": bytes_to_uint64(h3_col.statistics.min),
                    "h3_max": bytes_to_uint64(h3_col.statistics.max),
                    "byte_offset": h3_col.data_page_offset,
                    "byte_length": rg_meta.total_byte_size,
                    "rows": rg_meta.num_rows,
                    "cols": {
                        pf.schema_arrow.field(c).name: {
                            "offset": rg_meta.column(c).data_page_offset,
                            "length": rg_meta.column(c).total_compressed_size,
                        }
                        for c in range(pf.num_columns)
                    }
                })
            files.append({
                "key": f"cells/pyramid/r{res}/{parquet_path.stem}.parquet",
                "shard_h3": parquet_path.stem if parquet_path.stem != f"r{res}" else None,
                "size": parquet_path.stat().st_size,
                "row_groups": rgs
            })
        m["levels"][str(res)] = {
            "shard_res": SHARD_RES_BY_DATA_RES[res],
            "files": files
        }
    return m
```

DVX-track the manifest as an output of the pyramid build so it's
regenerated whenever the pyramid rebuilds. Baked into the worker via
`wrangler` bundling at deploy time.

## Rollout

**Order matters — the layout change and the manifest must ship together.**

1. **`e`**: Rebuild the pyramid with the per-res sizing table above.
   Verify actual row counts against the estimates; adjust files/RGs if
   off by >2×.
2. **`e`**: Run `njdot compute cells manifest` — produces
   `cells-api/manifest.v3.json`.
3. **`m3` or `e`**: Land the worker code path (`queryPyramid` →
   manifest-driven). Verify against the generated manifest.
4. **`e`**: `wrangler deploy` the worker with the manifest baked in.
   Simultaneously: `dvx push` the new pyramid to R2 (old pyramid stays
   live during transition; new pyramid lives at a different key prefix,
   e.g. `cells/pyramid.v3/…`, until cutover). Update the manifest's
   `key` fields to point at the new prefix.
5. **Cutover**: change the `CELLS_PREFIX` binding in the worker to point
   at the new prefix and redeploy. Old worker version stays around per
   CF's normal rollback semantics.
6. **Delete the old pyramid** (`cells/pyramid/…`) once cutover is
   confirmed. R2 storage drops back to ~460 MB new pyramid, same as
   before.

## Measurement plan

Reuse `e2e/map-budget-sweep.spec.ts` — same 8 scenarios, same 100k
default budget, log the wall-clock per shard request.

Success criteria:

- Wide-vp (state-z07, state-z08): p95 < 500 ms (baseline: 2–6 s)
- Mid-vp (state-z10, hudson-z12): p95 < 300 ms (baseline: 3–8 s)
- Deep-zoom (jc-z13, dt-jc-z17): p95 < 150 ms (baseline: 0.6–1.5 s)

If any category misses target by >2×, revisit the RG sizing (probably
RG-per-file count is too high or too low for that regime).

## Orthogonal / future

- **D1 fast-path** for the "all years, default severity" query — the
  common case. Sub-100 ms globally via CF edge. Layered on top of the
  parquet worker (client checks: default filter → D1 endpoint, custom
  filter → parquet worker). Separate spec; land after (this) is
  measured.
- **Client-side result cache** — currently absent. Worker responses are
  memoized per URL by the browser's HTTP cache but not across viewport
  overlaps (each viewport has a unique polygon param). Adding an
  IndexedDB layer keyed by `(shard, res, years, sev)` would eliminate
  refetches on backtrack-pan. Cheap; worth doing whenever.

## Open questions

1. **hyparquet-JS RG-only decode.** Can we decode a bare RG (no footer)
   with the current API? If not, does the "fake full-file buffer" hack
   work stably, or do we need to fork hyparquet? `e` verify.
2. **Multi-file vs single-file at fine res.** The per-res table above
   picks r2-sharding for r13–r15 based on the r4→r2 area ratio. Real
   row counts might justify keeping r4 for r15 (current). `e` — measure
   and pick.
3. **Manifest size vs. worker bundle limit.** Uncompressed manifest is
   probably 1–3 MB. Gzipped, well under CF's 1 MB compressed bundle
   limit. If it doesn't fit, ship the manifest as a KV binding lookup
   (one KV read at isolate-cold) instead of bundle-inline.
