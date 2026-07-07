# cells-api: extend pyramid to r15

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

**Sidecar / sld coverage** — no change. `hex-sld.parquet` covers
r6-r11 with `SLD_MAX_RES=11`; the worker's `joinSld` already walks
r12-r15 up to their r11 parent for lookup. That's fine — a single
r11 cell's road label is a reasonable proxy for its ~50 r15
descendants.

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

## Rollout on `e`

```bash
# on e, after pulling latest main
git pull u main

# 1. build r15 raw h3 keys if not already present
env -u PYTHONPATH njdot compute cells raw -r 15 -f

# 2. build sharded r15 pyramid at the three combos we care about
env -u PYTHONPATH njdot compute cells pyramid-combos -c 's7:r15,s8:r15,s9:r15' -f

# 3. push to R2
env -u PYTHONPATH njdot compute cells push

# 4. verify manifest has new combos
curl -s https://crashes-cells-api.ryan-0dc.workers.dev/v1/manifest | jq '.pyramid_combos | map(.data_res) | unique'

# 5. bump worker env + deploy
# edit cells-api/wrangler.toml: BASE_RES = "15"
cd cells-api && pnpm wrangler deploy

# 6. verify
curl -s 'https://crashes-cells-api.ryan-0dc.workers.dev/v1/cells?cells=892a1008a0a7fff&res=15&years=2001-2026&severities=fip&shard_res=9' | jq '.res, (.cells | length)'
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
