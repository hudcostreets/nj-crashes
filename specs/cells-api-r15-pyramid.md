# cells-api: extend pyramid to r15 + bake sld into rows

## Motivation

At z ≥ 19 (deep street-level zoom), the client's `AUTO_RES_BY_ZOOM`
picker asks for `data_res=15`. The current pyramid maxes out at
`data_res=14` (see `data/cells/manifest.json` → `pyramid_combos`).

When the client requests a combo with `data_res=15`, the client's
cover picker (`useCellsApi:pickCover`) finds no matching combo,
returns empty cover, no fetch fires — and the map keeps showing
the last-fetched r14 data as stale. The debug widget says "r15"
but users see r14. Bugs the illusion of the picker.

Symptom the user hit: at
<https://crashes.hudcostreets.org/?llz=40.7269-74.0533+19.07+23+3>
the widget bolds r15 but the rendered dots are identical to
<https://crashes.hudcostreets.org/?llz=40.7269-74.0533+19.00+23+3>
which is r14.

## Design

Add `data_res=15` combos at the shard-res tiers actually used at
deep zoom (`s7`, `s8`, `s9`). Skip `s{5,6}_r15` — those shard cells
are so coarse that an `r15` payload inside one shard would be
gigantic and would only get fetched at zooms where r15 is
overwhelmingly useless.

New R2 keys:

```
pyramid/s7_r15/{h3_r7}.parquet     # ~4k shards, ~15 MB each
pyramid/s8_r15/{h3_r8}.parquet     # ~19k shards, ~3 MB each
pyramid/s9_r15/{h3_r9}.parquet     # ~70k shards, ~500 KB each
```

Estimated storage (all three combos): ~30-40 GB additional in R2.
Doubling the current pyramid's ~40 GB. Cheap on R2 pricing but a
real number.

Base_res bump: `cells-api/wrangler.toml`

```
[vars]
BASE_RES = "15"
PYRAMID_LEVELS = "6,7,8,9,10,11,12,13,14"
```

Worker code doesn't need changes; existing combo-path handler picks
up new combos automatically once the manifest lists them.

## Pipeline changes

**Bake sld INTO pyramid rows (delete sidecar path)** — while
rebuilding, add four string columns to every pyramid parquet row:
`sld_name, cross_sld_name, mun, county`. Populated by joining the
existing `hex-sld.parquet` against each row's h3 (parent-walk to
r11 for `data_res > 11` — same fallback the worker's `joinSld`
does today).

Storage impact: sld strings are per-h3, not per-(h3,year), and
dict-encode extremely well (a few hundred distinct road names per
county). Estimated ~+100-200 MB across the whole pyramid — under
1% growth. Trivial R2 cost.

Worker payoff: `joinSld`, `loadSldMap`, `SldRow`, and the whole
`hex-sld.parquet` file become dead code. Delete after the new
pyramid is live:

  - `cells-api/src/cells.ts`: drop `joinSld` calls in both request
    paths, drop the sld-cache module state, drop `SldRow` type
  - `data/cells/hex-sld.parquet`: delete from R2 after verification
  - `njdot/cli/reshard_hex_sld.py`: keep as-is (still emits the
    sidecar used by `export_hex_sld.dvc` outputs — sidecar
    becomes an intermediate consumed by the pyramid builder, no
    longer served directly)

Measured cost this replaces: **1.8-3.5 s per 35k-cell request**
(65-80% of the worker's total wall-clock). Baking eliminates it
entirely; requests drop to ~500-1000 ms for the same payload.

**Sidecar / sld coverage of the pyramid** — for `data_res > 11`
(r12-r15 cells), pipeline uses `cellToParent(h3, 11)` to inherit
the sld from the r11 ancestor. Same fallback the worker does
today; identical output.

**Pyramid emitter** — extend `njdot/cli/cells.py` (or the specific
`pyramid_combos` command) to accept r15 as a target data_res. The
pipeline already parametrizes over `(shard_res, data_res)` combos —
just add `s7:r15`, `s8:r15`, `s9:r15` to the combo list.

Rough shape of the compute per combo:

1. Read `data/cells/raw/h3_r14/` (crash-level rows keyed by r14 h3).
2. `latLngToCell(crash.lat, crash.lon, 15)` for each crash → r15 h3.
3. Group by (year, r15 h3) → count per severity tier per year.
4. Shard by `cellToParent(h3_r15, shard_res)`.
5. Write per-shard parquet with the standard schema.

Runtime: ~5-15 min per combo on `e`. Total ~30-45 min for the three
combos. Local (laptop) would be closer to an hour but doable.

## R2 push

`njdot compute cells push` mirrors `data/cells/` to
`s3://nj-crashes/cells/`. New `pyramid/s{7,8,9}_r15/` subdirs get
picked up automatically. `--delete` won't drop anything.

## Manifest

`data/cells/manifest.json` gets 3 new combo entries. Regenerated
automatically as part of the pipeline (see `cells.py`'s combo
enumeration).

## Worker deploy

`wrangler deploy` after the R2 push completes. Zero code change if
`base_res` env var doesn't need bumping — but bump it to 15
anyway so the worker's res-range validation
(`requestedRes > manifest.base_res` → 400) accepts r15 requests.

## Client — no change needed

`useCellsApi` derives available combos from the manifest. Once the
manifest lists `s{7,8,9}_r15`, `pickCover(combos, 15, ...)` returns
a non-empty cover and requests fire.

Client already reads `sld_name / cross_sld_name / mun / county` off
the `CellOut` — this shape is preserved regardless of whether the
worker populated them via sidecar-join (old) or the pyramid emitted
them pre-baked (new). No client refactor.

## Rollout on `e`

Two-part rebuild — r15 needs new combos, and every existing combo
needs sld baked in (r6-r14 all need +4 string cols). Whole pyramid
gets rewritten. Existing R2 objects can stay in place during the
build and get overwritten atomically at push time.

```bash
# on e, after pulling latest main
git pull u main
grhh   # align WT to just-pushed HEAD

# 1. update the pyramid-combos command to bake sld into every row.
#    Reads hex-sld.parquet, parent-walks to r11 for data_res > 11,
#    joins by h3 before per-shard write. Code changes live in
#    njdot/cli/cells.py (or wherever pyramid_combos is emitted).

# 2. build r15 raw h3 keys if not already present
env -u PYTHONPATH njdot compute cells raw -r 15 -f

# 3. rebuild the ENTIRE pyramid (all combos) with sld baked in.
#    Adds three new r15 combos, overwrites the existing combos with
#    the sld-enriched schema. Runtime: ~1-3 hours on e (dominated by
#    the fine-res combos).
env -u PYTHONPATH njdot compute cells pyramid-combos -f

# 4. push to R2 (both new and overwritten combos)
env -u PYTHONPATH njdot compute cells push

# 5. verify manifest has new combos + sld cols
curl -s https://crashes-cells-api.ryan-0dc.workers.dev/v1/manifest | jq '.pyramid_combos | map(.data_res) | unique'
# expect: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

# 6. code changes for the worker:
#    - bump BASE_RES = "15" in cells-api/wrangler.toml
#    - delete joinSld, loadSldMap, SldRow, sld cache module state
#    - drop the two joinSld call sites in handleCellsRequest
#    - readParquetFromR2's `columns` arg extends to include the
#      four sld cols so they flow through to CellOut

# 7. deploy worker
cd cells-api && pnpm wrangler deploy

# 8. verify: response includes sld fields directly (no join step)
curl -s 'https://crashes-cells-api.ryan-0dc.workers.dev/v1/cells?cells=892a1008a0a7fff&res=15&years=2001-2026&severities=fip&shard_res=9' | jq '.res, .cells[0]'

# 9. once verified, delete the standalone sidecar
aws --profile cf s3 rm s3://nj-crashes/cells/hex-sld.parquet
```

## Tests / verification

- Live: hit the two URLs from the issue; z=19.07 should show r15
  dots (visibly smaller than z=19.0's r14 dots).
- The debug widget's "r15·X.Ypx" label should now correspond to
  actually-fetched r15 data, not stale r14.

## Non-goals

- Not extending to r16+. r15 is fine enough for street-level views
  and further res levels have negligible visual return for the
  storage cost.
- Not adding `s{5,6}_r15` combos. Those shard cells are too large
  for r15 payloads to be tractable. If a corner-case ever needs r15
  at coarse zoom, add them then.
- Not touching the sld sidecar. `SLD_MAX_RES=11` parent-walk works
  fine for r15 cells.

## Rollback

Undo is easy: delete `pyramid/s{7,8,9}_r15/*` from R2, revert
`BASE_RES` env var, redeploy worker. Client's cover picker starts
returning empty covers for r15 requests again — same failure mode
that exists today.

## Followups

- Update `AUTO_RES_BY_ZOOM` `20:15` → `20:15` (already there).
  Confirm nothing needs updating.
- Consider bumping `19:15, 20:15` further if r15 at z=20 is still
  too coarse-feeling once landed.
