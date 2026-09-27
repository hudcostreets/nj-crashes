# Road model v5: corridors, chainage, blocks, intersections

**Status:** v5 built statewide (Batch `roads-20260927-113129`). **v5.1** (branch `road-v5-1`, [below](#v51)) fixes block ↔ crash consistency, cuts blocks at gaps, adds block / corridor intersection counts, a monthly corridor summary, corridor-level placement of direction-ambiguous names, and makes the build ~3–6× faster; tested on the fixtures and the Hudson / Bergen dev builds, not yet built statewide (`roads.dvc` is stale: code deps changed).

Builds on [`road-data-v4.md`] and [`crash-location-recovery.md`]. Code:

- `njdot/road_model.py` (new): pieces / chainage, corridors, intersection nodes, blocks, crash ↔ node association
- `njdot/road_overrides.py` + `njdot/data/road_overrides.yml` (new): curated overrides
- `njdot/road_anomalies.py` (new): `njdot roads audit-anomalies`
- `njdot/road_net.py`: direction variants, placeholder names
- `njdot/loc_recovery.py`: county-scoped `sri_only`, retired-SRI calibration, route suffix words
- `njdot/cli/roads.py`: wiring and the new files

## Contents

- [v5.1](#v51): block convention, gap cuts, block / corridor counts, `corridor_only`, types, build speed
- [What changed](#what-changed)
- [Data model](#data-model): entity, corridor, piece / chain, block, intersection node
- [Files](#files): schemas, sorts, row groups, stats
- [Span queries](#span-queries): recipes and bytes
- [Intersections and X](#intersections-and-x)
- [West Side Ave](#west-side-ave): the 2011–13 / 2017 dip
- [J F Kennedy Blvd count mismatch](#j-f-kennedy-blvd-count-mismatch)
- [Other data fixes](#other-data-fixes)
- [Overrides](#overrides)
- [Anomaly audit](#anomaly-audit)
- [Recovery precision: entity vs corridor](#recovery-precision-entity-vs-corridor)
- [Build runtime](#build-runtime)
- [Frontend notes](#frontend-notes)
- [Tests](#tests)
- [Build](#build)
- [Open questions](#open-questions)

## v5.1

Changes on branch `road-v5-1`, from gaps the frontend's span selection found. Additive: no column removed or renamed; new columns come last.

### Block convention

A placed crash row (non-null `chain`) is in exactly one block of its row's `entity`, stored as `block` on `crashes-by-entity` and `crashes-by-entity-xs`. `road-blocks.n_*` = those rows counted by `block`, and `n_*_xs` = the `-xs` rows counted by `block`. So `SUM(n_crashes)` over blocks `b0..b1` equals `crashes-by-entity WHERE entity = E AND block BETWEEN b0 AND b1`, exactly. Unplaced rows (null `chain`, incl. pinned ones with `chain_lo` / `chain_hi`) have no block.

The rule, which the frontend can reproduce from stored values alone (all float32):

1. **Position.** A row at an intersection node (`node` non-null, with a `road-node-entities.chain` for `(entity, node)`) takes that node's chain. Otherwise it takes its own `chain`. `-xs` rows' `chain` already is the node's chain.
2. **Block.** It's in the entity's last block with `chain_lo ≤ position`, or the first block if the position is below all of them. Equivalently `[chain_lo, next block's chain_lo)`, open-ended for the last block.

So a crash at a node is in the block that *starts* at the node, wherever its own point is (NJDOT puts it up to X before or after the node). A crash at a section's end goes to that section's last block. The v5 frontend rule (`[chain_lo, chain_hi)` with a 1e-4 mi tolerance) disagreed with the build on most blocks: on West Side Ave, 14 of 54 matched. The build compared float64 crash chains against float64 node chains; its node crashes sit exactly on block boundaries, one float32 ulp either side. Prefer the `block` column; recompute only where you have to.

| Hudson dev build | Blocks whose `n_crashes` = rows by `block` = the rule above | v5 (FE rule `[lo, hi)`) |
|---|---:|---:|
| West Side Ave (JC) | 54 / 54 | 14 / 54 |
| J F Kennedy Blvd | 268 / 268 | 78 / 268 |
| Tonnelle Ave | 71 / 71 | 33 / 72 |

Totals are unchanged: blocks still sum to the road's placed crashes (West Side 3,433, JFK 30,659, Tonnelle 15,697), and `n_*_xs` sums to `road-entities.n_*_xs`. `tests/test_road_model.py::test_real_blocks_match_crash_rows` asserts all of this on the fixtures.

### Blocks cut at gaps

v5 cut an entity only at nodes and at the *start* of a `gap` / `branch` piece, so the block before a gap ran across it. West Side Ave's block 51 ran from Broadway to "US 1 Truck & St Pauls" (chain 2.78–3.15), across Journal Square. Blocks are now built per section (pieces joined `contiguous`). Block 51 is 2.78–2.94 (Broadway → the end of `09061725__`), and block 52 starts at 3.15. Nothing is in the gap: `chain` is clamped into pieces.

- Hudson: 11,601 → 11,556 blocks. On 42 roads a gap-spanning block became a trimmed one, or merged into the node at the next section's start.
- West Side Ave keeps 54 blocks, since the node at 3.15 was already a cut. Tonnelle Ave goes 72 → 71.

### Types

Chains are float32 wherever the frontend compares them: `crashes-by-entity{,-xs}.chain` / `chain_lo` / `chain_hi` (v5's `-xs` wrote double), `road-blocks.chain_lo` / `chain_hi`, `road-node-entities.chain` and `sri-geom.chain`. `road-pieces` keeps double: it's for mapping MPs, not for comparing positions. `road-corridors.corridor` is int32 (v5 wrote int64), as are `road-corridor-summary{,-monthly}.corridor` and `road-entities.corridor`.

### Corridor monthly summary

`road-corridor-summary-monthly.parquet`: as `road-summary-monthly` (with `n_unplaced`, `n_node`, `n_xs` / `tk_xs` / `ti_xs`, `n_corridor_only`), keyed and sorted `(corridor, year, month, severity)`. Row groups 20,000; stats on `corridor`. Hudson 27,467 rows.

### Corridor only

Since v5 split direction variants into separate entities, a road string without its direction ("48TH ST" in Bayonne: East / West 48th Street) names several entities, and `name_only` couldn't pick one. The crash was left off every road.

- **Recovery.** `recover` returns the candidate entities as `cands` when a name resolves to several entities in the muni.
- **Build.** When all candidates are members of one corridor (`road_model.corridor_only_rows`), the crash goes on a representative member, `loc_source` `name_only` (no chain, no point). The representative is chosen in this order:
  1. the candidate whose intersections include the crash's cross street (the pinned-node rule of [Intersections](#intersections-and-x));
  2. else the candidate in the crash's muni;
  3. else the corridor's spine;
  4. else the longest;
  5. else the lowest id.
- **`corridor_only`** (bool, `crashes-by-entity{,-xs}`) is true unless exactly one candidate has the cross street's intersection. When it's true, the crash is on the corridor but not on a particular side, and the frontend should say so ("located to the 48th Street corridor"). `road-summary{,-monthly}` / `road-corridor-summary{,-monthly}` get `n_corridor_only` (of `n`).
- **Overrides** don't apply to these rows: they're added after overrides, in the model step.

| Dev build | Crashes naming several roads | on one corridor | of which `corridor_only` | pinned to one side |
|---|---:|---:|---:|---:|
| Hudson `-C 9` | 4,212 | **1,467** | 1,176 | 291 |
| Bergen `-C 2` | 3,604 | **1,633** | 1,463 | 170 |

Hudson's 1,467 are mostly Bayonne's East / West numbered streets (22nd St 82, 32nd 58, 26th 58, …) and the 5th St / 53rd St corridors. That covers the 882 the v5 split pushed off-road, plus names v4 hadn't merged either. The other 2,745 name candidates on no one corridor ([Open questions](#open-questions)). Totals rise by exactly the placed crashes: Hudson `crashes-by-entity` 403,016 → 404,483, `name_only` 54,748 → 56,215. JFK Blvd's `n_crashes_xs` rises 5,391 → 5,438, because Bayonne corridor crashes pinned at JFK intersections now count there. Its `n_crashes` (36,148), West Side's (3,788) and Tonnelle's (16,139) are unchanged.

**Precision** (Hudson blind re-location, `tmp/ev6.py`; coded crashes with SRI / MP / points blanked, scored against NJDOT's own coding):

| Mode | Coded crashes | → corridor-only | Corridor right | Representative = NJDOT's entity |
|---|---:|---:|---:|---:|
| `name` (all years; cross street blanked too: the road name alone) | 100,000 | 139 | **100%** | 61% |
| `new` (2021+) | 74,561 | 3 | 100% | 2 / 3 |

At the corridor level these placements are exact. At the entity level the representative is a coin flip by construction, which is why the flag exists.

### Build speed

The statewide v5 stage took 1,906 s on Batch. The v4 stage took ~160 s without crash location recovery, and 1,429 s once recovery was added (`roads-20260927-121252`). So most of the time was recovery, then the v5 model. Both scale linearly, with nothing quadratic except `road_corridors`' `chain_at` over the whole pieces table, now fixed. The cost was per-crash Python work, which Batch's cores run ~2–3× slower than the laptop. Fixes (outputs byte-identical on the Hudson / Bergen builds, except where noted):

- **Strings once per distinct value** (`road_net.per_unique`). `norm_name`, `merge_key`, `dir_key`, `loc_key`, `clean_road`, `ordinalize`, `base_key`, `nodir_key` and `route_keys` run once per distinct value; `split_road` / `route_sri` once per distinct pair; `resolve_keys` once per distinct `(cc, mc, key)`. Statewide, ~7M road / cross strings have a few hundred thousand distinct values.
- **Fuzzy names** (`CloseMatcher`). Numpy length / character-multiset bounds prefilter the candidates, then `difflib` runs on the survivors only. The result equals `difflib.get_close_matches`.
- **Recovery memo split** (`_locate_one`). The road × cross-street meet point (`_locate_strings`), the offset, and the point snap are each cached on their own inputs. The old per-crash key included the (unique) point and the offset, so it rarely hit.
- **Snap** (`Snapper.snap`). Distances to the road's SRIs' own features, not a query of the statewide tree. The tree only breaks exact ties, so results match.
- **Parallel recovery loop** (`_locate_all`). Forked processes (`RECOVER_PROCS` = min(8, CPUs); `ROADS_PROCS=1` disables), whole munis per chunk, `gc.freeze()` against copy-on-write.
- **Model loops.** `cross_keys` once per distinct `(cc, mc, cross street)`; `entity_pieces` vectorized for single-piece entities; `road_corridors` calls `chain_at` on the member's own pieces; `road_blocks` is one pass over sorted arrays; vectorized `intersection_nodes` / `node_table` / entity counts.
- **Determinism.** `assign_crashes` breaks sort ties by row (AASHTO rows have no `id`; DuckDB's sort isn't stable), and a learned road's SRIs are sorted before `offset_along`. Both were run-to-run nondeterministic: 12 rows of Bergen's `crashes-by-entity` reordered; one Hudson crash's recovered SRI flipped.
- **Timings.** `Steps` logs each step's wall time in the build log.

Laptop, same load, v5 → v5.1 (wall s):

| Build | Total | Recovery | v5 model | `road_outputs` |
|---|---:|---:|---:|---:|
| Hudson `-C 9` | 53 → 28 | 28 → 6 (11 with `ROADS_PROCS=1`) | 8 → 2 | ~8.5 → 3.6 |
| Bergen `-C 2` | 79 → 31 | 40 → 5 (10 serial) | 14 → 4 | ~21 → 8 |

The rest of v5.1's total is v4's: loading crashes (~10 s) and points / runs / entities. Statewide projection from the county ratios: recovery + model ~5–6× faster, so the Batch stage goes from ~1,900 s to **~400–550 s**. That's an estimate; the next Batch run's log has the per-step times. The recovery pool forks up to 8 workers: watch the first statewide run's peak memory (`mem_gb: 16` in `roads.dvc` is a scheduling hint).

**Output size.** The statewide v5 roads dir grew 357 → 464 MB (+107 MB):

| File | MB |
|---|---:|
| `crashes-by-entity-xs` (new) | +69.7 |
| `road-blocks` (new) | +8.9 |
| `crashes-by-entity` (5 columns) | +7.9 |
| `road-summary-monthly` (4 columns, `n = 0` rows with `n_xs`) | +4.8 |
| `road-node-entities` (new) | +4.4 |
| `road-nodes` (new) | +4.1 |
| `road-summary` | +2.2 |
| `road-pieces` (new) | +1.7 |
| `sri-geom` (`chain`) | +1.2 |
| `road-entities` | +0.8 |
| `road-corridor-summary` / `road-corridors` (new) | +0.7 |

`-xs` repeats every crash column once per other road at the node (2.7M rows). If its size matters, it could carry only `(entity, chain, block, node, own_entity, id / case keys)` and let the frontend join `crashes-by-entity` for the rest. Not done: the frontend reads it today.

## What changed

| Area | Change |
|---|---|
| Entities | **Direction variants are separate entities again** ("East 48th Street" / "West 48th Street", "Black Horse Pike" / "East Black Horse Pike"); grouped by corridors instead. NG9-1-1 "Unnamed Segment" names are no longer names. |
| **Corridors** (new) | Groups of entities that are one right-of-way: direction variants and same-name continuations end to end, parallel carriageways / co-signed lines of one route (Tonnelle Ave + NJDOT's "US 1 SECONDARY"). `road-corridors`, `road-corridor-summary`; `road-entities.corridor`. |
| **Chainage** (new) | Every entity has a continuous mile coordinate `chain` over all its SRIs: `road-pieces`; `chain` on `sri-geom`, `crashes-by-entity`, `road-node-entities`, `road-blocks`. Corridors map member chains linearly. |
| **Blocks** (new) | Each entity cut at its intersections: `road-blocks`, with crash counts. |
| **Intersections** (new) | NG9-1-1 nodes where ≥ 2 roads meet (`road-nodes`, `road-node-entities`). Crashes at a node count on every road there: `crashes-by-entity.node`, `crashes-by-entity-xs` (the other roads' copies), and `n_xs` / `n_*_xs` in summaries. |
| Recovery | `sri_only` is county-scoped (the JFK fix); retired SRIs are calibrated against their own located crashes (new `loc_source` `sri_calib`); "WESTERN" / "EXPRESS" / "SECONDARY" route words pick the SRI. |
| **Overrides** (new) | `njdot/data/road_overrides.yml`, applied by the build with provenance (`crashes-by-entity.override`). Seeded empty (see [Overrides](#overrides)). |
| **Audit** (new) | `njdot roads audit-anomalies`: ranked review queue (CSV / markdown). |

**Backward compatibility:** no file or column is removed or renamed. New columns come after v4's in every file. Changes a v4 reader can notice:

- `crashes-by-entity` is sorted by `chain` within an entity (v4: `sri, mp`).
- `loc_source` has a new value, `sri_calib`. It's a placed crash (SRI, MP and point).
- `road-summary{,-monthly}` has rows with `n = 0` where only `n_xs` is non-zero. Sums of `n` are unaffected.
- Entities split: some slugs change and new slugs appear. Direction variants get their own slugs (`hudson/bayonne/east-48th-street`), and the v4 merged entity keeps its slug only if its name is still the majority name.

## Data model

```
corridor  (road-corridors)            "48th Street" (Bayonne) · "Tonnelle Avenue" (+ US 1 SECONDARY)
 └─ entity (road-entities)            "West 48th Street" · "Tonnelle Avenue" — v4's road, slug, page
     ├─ piece (road-pieces)           one MP-contiguous stretch of one SRI (both carriageways): chain_lo..chain_hi
     ├─ block (road-blocks)           between two intersections: chain_lo..chain_hi
     └─ node  (road-node-entities)    an intersection at a chain position
crash (crashes-by-entity)             entity + chain (+ node if at an intersection)
```

### Pieces and chain

`entity_pieces`, `chain_at`.

1. **Group:** an entity's runs are grouped by their *MP reference SRI*: the SRI itself, or a secondary carriageway's parent (`00000001_S` → `00000001__`), so both carriageways of a divided road are one piece.
2. **Cut:** within a group, runs whose MPs leave a gap > 0.15 mi (`PIECE_GAP_MP`) start a new piece. A piece's `[mp_lo, mp_hi]` is its runs' crash interval `[mp_lo, mp_end)`.
3. **Order** (`_order_pieces`):
   - Start at the piece end lowest along the principal axis of all the entity's piece ends.
   - Repeatedly append the unvisited piece with an end nearest the current tail, oriented so that end comes first.
   - Label each join by that distance: `contiguous` ≤ 60 m, `gap` ≤ 400 m, `branch` farther.
   - Chain adds the distance between the ends, capped at 0.25 mi (`CHAIN_MAX_GAP_MI`).
4. **Direction:** the whole order is reversed if needed so the longest piece runs with increasing MP (`dir` = 1). Chain therefore usually follows NJDOT's MP direction: south → north, west → east.
5. **Mapping:** `chain(mp) = chain_lo + (mp − mp_lo)` when `dir` = 1, else `chain_lo + (mp_hi − mp)`.

Properties:

- Monotonic within a piece, continuous across contiguous joins, never overlapping, starting at 0.
- `road-entities.chain_mi` is the chain's end. It's ≥ `length_mi`, since it includes gaps; `length_mi` stays the road's measured miles.
- Branches (a spur off the middle of a road) come after the main line with a ≤ 0.25 mi break, so a chain range never mixes a spur into the main line. Their `join` is `branch`.

Examples (real fixtures):

| Entity | Pieces |
|---|---|
| J F Kennedy Blvd | `09000690__` 0–0.62 → CR 501 23.81–37.31 (chain 0.62–14.12) → `09000693__` 2.64 → 2.35 backwards (14.12–14.41) |
| West Side Ave, JC | `09061684__` 0–1.95 → `09061575__` (1.98–2.21) → `09061725__` (2.21–2.94) → Journal Square gap (`gap`, +0.21) → `09061374__` (3.15–3.48) |

### Corridors

`corridor_pairs`, `road_corridors`. Two non-ramp entities pair when they are:

- **sequential**: their names are direction variants or the same name, and they touch end to end. "Direction variants" means the same `dir_key`, which is `merge_key` without a leading or trailing direction word, only when ≥ 2 words remain: "West 48th Street" / "East 48th Street" → `48THST`, "North Avenue East" → `NORTHAVE`. "Touch" means a piece end within 100 m (`SEQ_M`) of the other's points, or consecutive runs on one SRI. Consecutive runs on one SRI also pair when one entity isn't NG9-1-1-named: its points keep NJDOT's SLD name ("I-95, N.J. TURNPIKE"), so it's the same road where NG9-1-1 has a gap.
- **parallel**: ≥ 60% (`PAR_FRAC`) and ≥ 4 of the shorter entity's points lie within 40 m (`PAR_M`) of the other's, heading within ~25° (`PAR_COS` 0.9). They must also share an SRI route number (`sri[:8]`: `00000001__` / `00000001_S`) or have related names.

Corridors are the connected components. **Only multi-entity corridors exist**; `road-entities.corridor` is null for the rest.

- **Spine:** the NG9-1-1-named member with the longest chain. It names the corridor (a direction word stripped for sequential corridors: "48th Street").
- **Mapping:** members map onto the corridor's chain as `cchain = corridor_c0 + corridor_sign · chain`.
  - A sequential member attaches end to end past whichever corridor end it's nearer to.
  - A parallel member maps through the MPs it shares with a placed member (a secondary carriageway: exact), else by the median offset to its points' nearest placed points.
  - The corridor chain starts at 0.
- `kind`: `sequential`, `parallel` or `mixed`.

| County build | Corridors | Entities in them |
|---|---:|---:|
| Hudson (`-C 9`, incl. edge-of-bbox neighbors) | 141 | 324 |
| Bergen (`-C 2`) | 499 | 1,126 |
| Hunterdon (`-C 10`) | 109 | 249 |

Statewide, v4 had 1,046 entities that merged direction variants (325,908 crashes). Expect roughly 4–6k corridors.

Examples:

- `hudson/tonnelle-avenue` (parallel, real fixtures): Tonnelle Ave + "US 1 SECONDARY" (its parent MPs 59.46–60.01 → corridor chain 4.86–5.41). In the `-C 9` build it's `mixed`: that subset has no Bergen NG9-1-1 names, so US 1's lines past the county line stay SLD-named and join as unnamed continuations. Statewide they're Bergen's Broad Ave and won't.
- `hudson/bayonne/48th-street` (sequential): East 48th Street (0–0.15) + West 48th Street (0.20–0.83).
- `bergen/kinderkamack-road`: Kinderkamack Road + its SLD-named piece + North / South Kinderkamack Road (Montvale).
- `nj/us-highway-1`: US Highway 1 across the Union / Essex line.

### Intersection nodes

`intersection_nodes`.

1. **Clusters:** NG9-1-1 segment end points within 1 m of each other (NG9-1-1 is noded) form a cluster.
2. **Legs:** each segment end at a cluster is a leg. A leg's *road* is its segment's entity, mapped to that entity's corridor. A leg on no entity takes its NG9-1-1 name, unless the name is one of an entity's names at the same point: "Kennedy Boulevard" beside J F Kennedy Boulevard is that road.
   - Ramps don't count: ramp entities, and SLD-style ramp names ("FR US 1 SB to RAMP …").
   - Placeholder names don't count: "Unnamed Segment", "Driveway".
3. **Node:** a cluster with ≥ 3 legs and ≥ 2 roads, ≥ 1 of them an entity. A 2-leg name change isn't an intersection.
4. **Merge:** nodes within 40 m (`NODE_MERGE_M`) that join the same ≥ 2 roads are one intersection: both carriageways of a divided road crossing a street, or a jog.
5. **Position:** each node's position on each of its roads (`road-node-entities.chain`) comes from its legs on that road. The leg's segment end is located on its NJDOT line → MP → `chain_at`, averaged over the road's legs.
6. **Ids:** node ids are assigned in S2 (level 16) cell order.

| County | Nodes | Blocks | Crashes at a node |
|---|---:|---:|---:|
| Hudson | 4,375 | 11,601 | 206,914 (51.3%) |
| Bergen | 18,610 | 46,713 | 301,598 (48.7%) |
| Hunterdon | 3,450 | 8,973 | 26,714 (31.9%) |

### Blocks

`road_blocks`. An entity's *sections* (runs of pieces joined `contiguous`; a `gap` / `branch` join starts a new one) are cut at the nodes on them. No block spans a gap / branch: the chain between two sections (where there's no road) is in no block, so a block's `chain_hi` can be below the next block's `chain_lo`. Cuts closer than 0.005 mi merge, keeping the first position and a node over a section end. Each block has the cross streets at its ends (`from_name` / `to_name`) and counts of the crash rows in it: by their `block` column ([v5.1](#block-convention)).

## Files

All zstd, as in v4: only the listed columns have min/max stats, only the listed columns are dictionary-encoded, and there's no pandas / Arrow footer metadata. "Rows (Hudson)" are from the `-C 9` build.

### `crashes-by-entity.parquet` (changed)

v4 columns, then:

| Column | Type | |
|---|---|---|
| `chain` | float32? | the crash's chain on its entity (mi); null when unplaced (`sri_only` / `name_only`, or an override moved it to a road its SRI isn't on) |
| `chain_lo`, `chain_hi` | float32? | unplaced crashes whose cross street pins them: the node's chain ± the police distance (equal when "at" the intersection); else null |
| `node` | int32? | the intersection node the crash is at ([Intersections](#intersections-and-x)) |
| `override` | string? | id of the override rule that moved it |
| `block` | int32? | v5.1: its block on `entity` ([convention](#block-convention)); null when unplaced (no `chain`) |
| `corridor_only` | bool | v5.1: its road name is several members of one corridor and nothing picks the side: `entity` is a representative ([`corridor_only`](#corridor-only)) |

- **Sort:** `(entity, unplaced, chain, dt, id)`, `unplaced` = no chain. v4 sorted by `sri, mp` within an entity.
- **Row groups:** 10,000.
- **Stats:** `entity`, `chain`.
- **Dict:** v4's + `override`.
- `loc_source` gains `sri_calib` ([Other data fixes](#other-data-fixes)).

### `crashes-by-entity-xs.parquet` (new)

Inclusive rows: for every crash at a node, one row per *other* non-ramp road at that node.

- **Columns:** `crashes-by-entity`'s v4 / v5 ones, with `entity` = the other road, `chain` = the node's chain on it (float32, = `road-node-entities.chain`) and `chain_lo` / `chain_hi` null (float32), then `own_entity` (int32, the road the crash is on), then v5.1's `block` (the block on `entity` starting at the node; null when the node has no chain there) and `corridor_only`.
- **Sort:** `(entity, chain, dt, id)`. **Row groups:** 10,000. **Stats:** `entity`, `chain`. **Dict:** as `crashes-by-entity`.
- A road's inclusive crash list is `crashes-by-entity` ∪ `crashes-by-entity-xs` for its entity. The two never share a crash for one entity.
- Rows: Hudson 218,224 (vs 403,016 exclusive). Statewide estimate ~2.5–3M, ~55–65 MB.

### `road-entities.parquet` (changed)

v4 columns, then:

| Column | Type | |
|---|---|---|
| `corridor` | int32? | its corridor (null: none) |
| `corridor_c0`, `corridor_sign` | float32?, int8? | `cchain = corridor_c0 + corridor_sign · chain` |
| `chain_mi` | float32 | chain end (mi) |
| `n_nodes` | int32 | intersections on it |
| `n_crashes_xs`, `n_fatal_xs`, `n_injury_xs`, `n_killed_xs` | int32 | other roads' crashes at its intersections; inclusive = `n_*` + `n_*_xs` |

`n_crashes` etc. are now counted after overrides.

### `road-summary.parquet` / `road-summary-monthly.parquet` (changed)

v4 columns, then:

| Column | Type | |
|---|---|---|
| `n_node` | int32 | of `n`, crashes at an intersection node |
| `n_xs`, `tk_xs`, `ti_xs` | int32 | other roads' crashes at this road's intersections (crashes / killed / injured) |
| `n_corridor_only` | int32 | v5.1: of `n`, `corridor_only` crashes (located to the corridor, not this side) |

- `n` stays exclusive: it sums to the total across roads. Inclusive = `n + n_xs`, which double counts across roads by design.
- A cell exists when `n` or `n_xs` is non-zero.

### `sri-geom.parquet` (changed)

+ `chain` (float32): each MP point's chain on its entity. Same sort, row groups and stats. `sri-hit*` don't carry it.

### `road-pieces.parquet` (new)

| Column | Type | |
|---|---|---|
| `entity` | int32 | |
| `piece` | int16 | 0-based, chain order |
| `sri` | string | MP reference SRI (a secondary's parent) |
| `mp_lo`, `mp_hi` | double | |
| `dir` | int8 | 1: chain grows with MP; -1: against |
| `chain_lo`, `chain_hi` | double | |
| `join` | string | `start` / `contiguous` / `gap` / `branch` |
| `gap_mi` | float32 | chain added before it |

**Sort:** `(entity, piece)`. **Row groups:** 2,000. **Stats:** `entity`. **Dict:** `sri`, `join`. Hudson 4,736 rows; statewide ~115k (~1.5 MB).

### `road-blocks.parquet` (new)

| Column | Type | |
|---|---|---|
| `entity`, `block` | int32 | `block` 0-based along the chain |
| `chain_lo`, `chain_hi`, `length_mi` | float32 | |
| `node_lo`, `node_hi` | int32? | the nodes at its ends (null: road end, or either side of a gap / branch) |
| `from_name`, `to_name` | string? | the cross streets there (`road-node-entities.cross`) |
| `n_crashes`, `n_fatal`, `n_injury`, `n_killed` | int32 | this road's placed crashes in the block: `crashes-by-entity` rows with this `block` ([convention](#block-convention)) |
| `n_crashes_xs`, `n_fatal_xs`, `n_injury_xs`, `n_killed_xs` | int32 | v5.1: other roads' crashes at this block's intersections: `crashes-by-entity-xs` rows with this `block` (a crash at a node counts in the block that *starts* at the node) |

**Sort:** `(entity, block)` (= `chain_lo`). **Row groups:** 4,000. **Stats:** `entity`, `chain_lo`, `chain_hi`. **Dict:** `from_name`, `to_name`. Hudson 11,556 rows (v5: 11,601) (median block 0.05 mi on urban arterials, 0.15 mi on Hunterdon's CR 523). Statewide ~0.45M (~8 MB).

### `road-nodes.parquet` (new)

| Column | Type | |
|---|---|---|
| `node` | int32 | S2-order id |
| `lon`, `lat` | float32 | |
| `n_legs` | int16 | NG9-1-1 segment ends there |
| `n_roads` | int16 | entities there (non-ramp) |
| `entities` | string | comma-joined entity ids |
| `label` | string | "West Side Avenue & Duncan Avenue" (entities by crashes, then NG9-1-1-only roads; ≤ 4) |
| `n_crashes`, `n_fatal`, `n_injury`, `n_killed` | int32 | crashes at the node, all roads, each once |

**Sort:** `node`. **Row groups:** 4,000. **Stats:** `node`, `lon`, `lat`. **Dict:** none. Hudson 4,375; statewide ~0.2M (~4 MB).

### `road-node-entities.parquet` (new)

One row per (road, node).

| Column | Type | |
|---|---|---|
| `entity` | int32 | |
| `chain` | float32 | the node's chain on this road |
| `node` | int32 | |
| `cross` | string? | the other roads' names there (" & ") |
| `n_crashes` | int32 | crashes at the node, all roads |
| `n_own` | int32 | of them, on this road |

**Sort:** `(entity, chain, node)`. **Row groups:** 4,000. **Stats:** `entity`, `chain`. **Dict:** `cross`. Hudson 8,670; statewide ~0.4M.

### `road-corridors.parquet` (new)

| Column | Type | |
|---|---|---|
| `corridor` | int32 | rank of `slug` (v5 wrote int64 by mistake) |
| `slug` | string | `<county>/<muni>/<name>`, `<county>/<name>`, or `nj/<name>` across counties; its own namespace, and may equal its spine entity's slug |
| `name` | string | |
| `kind` | string | `sequential` / `parallel` / `mixed` |
| `spine` | int32 | entity |
| `entities` | string | comma-joined member entity ids |
| `n_entities` | int16 | |
| `cc` | int8? | |
| `chain_mi` | float32 | corridor chain end |
| `length_mi` | float32 | union of members' corridor-chain ranges |
| bbox | double | |
| `n_crashes` … `n_killed` | int32 | members' crashes (exclusive: no crash twice) |
| `n_*_xs` | int32 | crashes at the corridor's intersections on roads outside it, once per crash |

**Sort:** `corridor`. **Row groups:** 1,000. **Stats:** `corridor`, `slug`. **Dict:** `kind`.

### `road-corridor-summary.parquet` / `road-corridor-summary-monthly.parquet` (new)

As `road-summary{,-monthly}` (incl. `n_unplaced`, `n_node`, the `_xs` columns and `n_corridor_only`), keyed `(corridor, year[, month], severity)`, sorted by those keys. `n_xs` counts crashes at the corridor's intersections on roads outside it, once per crash. **Row groups:** 10,000 / 20,000 (monthly, v5.1). **Stats:** `corridor`.

## Span queries

A *span* is an entity plus a chain range `[a, b]` (miles), or a corridor plus a corridor-chain range.

### Entity span

| Want | Query |
|---|---|
| Crashes on it | `crashes-by-entity WHERE entity = E AND chain BETWEEN a AND b` |
| … inclusive | also `UNION ALL crashes-by-entity-xs WHERE entity = E AND chain BETWEEN a AND b` |
| "N more on this road without a location" | whole road, `SUM(n_unplaced)` from `road-summary WHERE entity = E`. Pinned unplaced crashes (`chain_lo <= b AND chain_hi >= a`) can be shown as "approximately here". |
| Snap to blocks / block-level stats (no crash read) | `road-blocks WHERE entity = E`: sum `n_*` (`n_*_xs` for inclusive) of blocks `b0..b1` |
| … their crash rows | `crashes-by-entity WHERE entity = E AND block BETWEEN b0 AND b1` (+ `-xs` likewise): exactly the blocks' `n_*` |
| Its intersections | `road-node-entities WHERE entity = E AND chain BETWEEN a AND b` |
| Geometry | `sri-geom WHERE entity = E` (one group), filter `chain` client-side |
| Scope levels | block (one `road-blocks` row) → stretch (any `[a, b]`, snapped to block ends) → road (`[0, chain_mi]`) → corridor |

### Corridor span

1. Read `road-corridors WHERE slug = ?` → `entities`. The members' `corridor_c0` / `corridor_sign` are in `road-entities` (`WHERE entity = ?` for each, or the county-prefix read).
2. Each member's chain range is `[a − c0, b − c0]` when `sign` = 1, `[c0 − b, c0 − a]` when -1.
3. Query each member with **one `entity = ?` predicate per member**, `UNION ALL`. DuckDB-WASM (v0.9) doesn't prune on `IN` lists, and members' ids needn't be adjacent.
4. For inclusive counts, drop `crashes-by-entity-xs` rows whose `own_entity` is a member: they're already on the corridor.

### Bytes (measured on the Hudson build, projected statewide)

Footer + the column chunks of every row group whose stats overlap (`tmp/bytes.py`, as v4's method). Data per group is about the same statewide, since files are entity-sorted with fixed row-group sizes. Footers scale with the group count: statewide footers are projected from v4's measured footers and v5's per-group footer cost.

| Lookup | Hudson: groups / data | Statewide footer (proj.) | Statewide first lookup (proj.) | Cached |
|---|---|---:|---:|---:|
| `crashes-by-entity`, West Side Ave `chain` 1.0–1.5 | 1 of 41 / 225 KB | ~960 KB (v4 760) | ~1.2 MB | 225 KB |
| `crashes-by-entity`, JFK Blvd `chain` 6–7 (3,057 crashes) | 3 of 41 / 548 KB | ~960 KB | ~1.5 MB | 548 KB |
| `crashes-by-entity`, JFK whole road (36k) | 4 / 736 KB | ~960 KB | ~1.7 MB | 736 KB |
| `crashes-by-entity-xs`, one span | 1 of 22 / 220 KB | ~450 KB | ~670 KB | 220 KB |
| `road-blocks`, one road | 1 / 83 KB | ~100 KB | ~180 KB | 83 KB |
| `road-node-entities`, one road | 1 / 45 KB | ~40 KB | ~85 KB | 45 KB |
| `road-pieces`, one road | 1 / 32 KB | ~35 KB | ~65 KB | 32 KB |
| `road-corridors`, one corridor | 1 / 11 KB | ~5 KB | ~20 KB | 11 KB |
| `road-nodes`, one node (by id) | 1 / 82 KB | ~25 KB | ~105 KB | 82 KB |

- A block-snapped span costs `road-blocks` alone (~180 KB first, ~83 KB cached): no crash rows.
- A free span's crash list is ~1 group of `crashes-by-entity` (+ 1 of `-xs` for inclusive).
- The `crashes-by-entity` footer grows ~25% (5 more columns × ~600 groups, plus `chain` stats). That makes the parquet metadata cache (`SET parquet_metadata_cache = true`, [`road-data-v4.md`] § Measurement) more valuable. If it can't be enabled, consider moving `chain_lo`, `chain_hi` and `override` (rarely non-null) out to a sidecar.
- Chain pruning is loose where a row group spans two entities: a group's `chain` stats span both entities' ranges. JFK's 1-mile span reads 3 of its 4 groups for that reason. Always filter on `entity` too.

## Intersections and X

### Method

`crash_nodes`. A crash on road E is **at** node N when either rule holds:

1. **Named.** The crash's cross street (`split_road`: an "A / B" road string's B when there's none) resolves to a key of another road at a node of E. Keys come from `cross_keys`: the raw `loc_key`, `resolve_keys` matches in the crash's muni, and route keys ("RT 440" → `R:NJ440`).
   - The node is the nearest such node along E to the crash's point. It must be ≤ 150 m away (`NAMED_MAX_M`); otherwise the names mean another crossing, or the point is off.
   - The police must put the crash at or near it: NJDOT's `Intersection` flag is `I` (AASHTO: `Yes`) or the distance unit is `AT`, or the stated distance ≤ **X**.
   - AASHTO (2023+) has no distance, so an unflagged AASHTO crash qualifies when its point is ≤ X from the node.
   - Unplaced crashes (`name_only` / `sri_only`) are *pinned* when all their candidate nodes lie within 150 m: `chain_lo` / `chain_hi` = node chain ± the stated distance. They're at the node when flagged or within X.
2. **Geometric.** No usable cross street, but police flagged the crash an intersection crash: E's nearest node along the chain, if ≤ X.

**X by road class** of the crash's road (`XS_FT`):

| Class | X |
|---|---|
| state / US / interstate (`subt` 1–3) | 100 ft (30.5 m) |
| county, incl. 5xx (`subt` 4–6) | 75 ft (22.9 m) |
| local (`subt` 7) | 50 ft (15.2 m) |

### Evidence

**NJDOT has an intersection flag.** The Crash Table's "Intersection" field (1 char; `njdot/data/fields/2001CrashTable.json`, same in 2017) is `I` (at intersection), `B` (between intersections) or `R` (ramp); AASHTO 2023+ has `Yes` / `No`. `I` is exactly the crashes whose distance unit is `AT`: 2006 has 79,095 of each, 2019 has 81,509. Share `I`: ~27% of crashes per year, all years.

**NJDOT's point = node ± the stated distance.** NJDOT-coded crashes (2017–22) in Hudson, Bergen and Hunterdon, measured along the road from NJDOT's point to the node where the named cross street meets it:

| Police said | n | Median along-road distance to the node |
|---|---:|---:|
| `I` / AT, county roads | 25,040 | **0 m** (p75 0–7 m, p90 16–80 m) |
| `I` / AT, local roads | 19,473 | **0 m** (p75 6–10 m) |
| `I` / AT, state roads | 12,811 | 5–48 m (p75 21–65 m) |
| `B`, ≤ 25 ft | 21,320 | 0 m |
| `B`, 26–50 ft | 15,754 | 16 m |
| `B`, 51–75 ft | 3,947 | 16 m |
| `B`, 76–100 ft | 12,259 | 32 m |
| `B`, 101–150 ft | 4,545 | 48 m |
| `B`, 151–200 ft | 5,997 | 64 m |
| `B`, > 200 ft | 17,207 | 145 m |

- NJDOT puts intersection crashes on the node and offsets the rest by the police distance, at its 0.01-mi (16 m) MP resolution. For coded crashes geometry adds nothing to the stated distance, so **X is a threshold on the police distance**, and on geometry only where there's no distance: AASHTO, and crashes with no cross street.
- State roads are the exception: their `I` crashes sit a median 5–48 m off the NG9-1-1 node (wide intersections, carriageways, jughandles). Hence their larger X, and the 150 m cap for named nodes rather than X.

**Police distances heap on round values and decay smoothly; there's no natural break.** Cumulative share of per-table crashes whose cross street names a node on their road:

| Stated distance | ≤ 0 (AT) | ≤ 10 ft | ≤ 25 ft | ≤ 50 ft | ≤ 75 ft | ≤ 100 ft | ≤ 150 ft | ≤ 250 ft |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Share | 44.5% | 48.1% | 55.5% | 65.0% | 68.0% | 75.4% | 78.2% | 83.1% |

Statewide, `B` crashes' non-round distances fall from ~3.5k per 10 ft at 20–40 ft to ~2k at 90 ft and ~1k at 190 ft.

So X is set physically: the distance from an intersection's center to its stop bars, which covers the curb-to-curb box, crosswalks and stop lines.

- Local streets (~30–40 ft wide): ~50 ft.
- County arterials: ~75 ft.
- State highways (4–6 lanes, medians): ~100 ft.

These are also the round values police report, and `≤` includes them. The FHWA / HSM "intersection-related" 250 ft functional area would take 83% of named-node crashes, most of them mid-block. Too broad for "counted on both streets".

### Results on real roads

"At a node" = share of the road's own crashes at an intersection. "Inclusive" adds the other roads' crashes at its intersections.

| Road | Crashes (exclusive) | At a node | + other roads' | Inclusive | Nodes / blocks | Top intersection (crashes, all roads / on this road) |
|---|---:|---:|---:|---:|---|---|
| West Side Ave, JC (local) | 3,788 | 66% | 1,138 | 4,926 (+30%) | 54 / 54 | Communipaw Ave (444 / 192) |
| J F Kennedy Blvd, Hudson (CR 501) | 36,148 | 69% | 5,391 | 41,539 (+15%) | 268 / 268 | Hackensack Plank Rd & 32nd St (631 / 449) |
| Tonnelle Ave (US 1&9) | 16,139 | 50% | 5,058 | 21,197 (+31%) | 73 / 72 | Manhattan Ave (1,005 / 666) |
| Kinderkamack Rd, Bergen (CR 503, suburban) | 6,425 | 56% | 1,023 | 7,448 (+16%) | 127 / 128 | Old Hook Rd (303 / 137) |
| Sergeantsville Rd, Hunterdon (CR 523, rural) | 987 | 45% | 68 | 1,055 (+7%) | 30 / 31 | Dayton Rd (116 / 94) |

Crashes at a node: Hudson 51%, Bergen 49%, Hunterdon 32%. The inclusive uplift is largest on roads whose cross streets are busier than they are (Tonnelle Ave's highway junctions) and smallest in rural areas.

## West Side Ave

`hudson/jersey-city/west-side-avenue`, crashes per year.

- **v4:** the published statewide build.
- **v5:** the Hudson build. Exclusive = `n`; "calib" = of those, placed by retired-SRI calibration; "+ xs" = other roads' crashes at its intersections; inclusive = exclusive + xs.

| Year | v4 | v5 exclusive | calib | + xs | v5 inclusive |
|---|---:|---:|---:|---:|---:|
| 2001 | 23 | 157 | 134 | 10 | 167 |
| 2002 | 14 | 178 | 164 | 9 | 187 |
| 2003 | 19 | 166 | 147 | 6 | 172 |
| 2004 | 27 | 173 | 146 | 9 | 182 |
| 2005 | 21 | 120 | 99 | 10 | 130 |
| 2006 | 105 | 134 | 26 | 49 | 183 |
| 2007 | 162 | 177 | 13 | 74 | 251 |
| 2008 | 100 | 134 | 31 | 75 | 209 |
| 2009 | 79 | 167 | 88 | 53 | 220 |
| 2010 | 94 | 149 | 52 | 61 | 210 |
| **2011** | **27** | **177** | 150 | 64 | **241** |
| **2012** | **8** | **134** | 126 | 35 | **169** |
| **2013** | **16** | **160** | 144 | 47 | **207** |
| 2014 | 94 | 172 | 77 | 56 | 228 |
| 2015 | 66 | 169 | 103 | 42 | 211 |
| 2016 | 127 | 215 | 87 | 51 | 266 |
| **2017** | **5** | **183** | 178 | 27 | **210** |
| 2018 | 53 | 199 | 146 | 57 | 256 |
| 2019 | 172 | 172 | 0 | 81 | 253 |
| 2020 | 87 | 87 | 0 | 47 | 134 |
| 2021 | 107 | 107 | 0 | 54 | 161 |
| 2022 | 123 | 123 | 0 | 60 | 183 |
| 2023 | 94 | 94 | 0 | 42 | 136 |
| 2024 | 130 | 130 | 0 | 76 | 206 |
| 2025 | 111 | 111 | 0 | 43 | 154 |

**The dip is fixed, and its cause wasn't the one [`crash-location-recovery.md`] § 2 gave.**

- **Cause.** West Side Ave *is* Hudson County Route 605 (south of Journal Square) and CR 641 (north). Before 2019 NJDOT coded JC's crashes on it to those county-route SRIs, `09000605__` and `09000641__`, with road strings "HUDSON COUNTY 605" / "CR 641" and West Side's cross streets (Fulton, Stegman, Carbon, Jewett, Belmont, Fairview). Today's network has no `09000605__`: West Side Ave is `09061684__` et al. So those crashes sat off every road.
- **What the old explanation saw.** The "West Side as cross street" crashes of 2011–13 are the smaller part. They include crashes at "HUDSON COUNTY 612 & WEST SIDE" (CR 612 = Communipaw Ave), which were invisible the same way.
- **Fix.** Retired-SRI calibration ([Other data fixes](#other-data-fixes)) places 1,911 of West Side's pre-2019 crashes, from `09000605__`'s MPs, which map ~1:1 onto `09061684__`'s. Intersection counting adds the crashes other roads carry at its intersections.
- **Result.** 2011–13 / 2017 are now 134–183 exclusive (v4: 5–27) and 169–241 inclusive, in line with their neighbors.
- **Remaining step.** 2019 → 2020+ is 172 → 87–130 exclusive, 253 → 134–206 inclusive. 2020 is COVID, and statewide crashes fell 14% from 2019 to 2022; West Side fell ~30%. The anomaly audit doesn't flag it (below its 2× threshold), but it's worth a look.

## J F Kennedy Blvd count mismatch

**Statewide 31,314 vs. `-C 9` 36,127:** a 4,817-crash difference, all in one direction, plus 6 in the other.

| Crashes | Statewide | `-C 9` | Why |
|---|---:|---:|---|
| Coded `00000501__` (CR 501), **no MP**, Hudson (`cc` 9), 2001–2019 | none (off every road) | `sri_only` on JFK Blvd | below |
| Coded on JFK's SRIs but reported in another county (`cc` ≠ 9) | on JFK | not loaded | `-C 9` loads only Hudson's crashes |

**Root cause.**

- `sri_only` recovery put an SRI-without-MP crash on an entity only if *all* of the SRI's runs were one entity.
- Statewide, CR 501 is 15 entities (New Durham Rd, Amboy Ave … in Middlesex; J F Kennedy Blvd in Hudson; East Central Blvd … Piermont Rd in Bergen), so no.
- The `-C 9` subset keeps only NJDOT lines near Hudson, where CR 501 is JFK Blvd alone, so yes.

**The Hudson count is right.** Within Hudson, CR 501 *is* JFK Blvd (MP 23.81–37.31, one entity), so a Hudson crash coded CR 501 is on it. The 4,817 crashes split by period as 1,387 (2001–05), 1,724 (2006–10), 1,154 (2011–15), 549 (2016–19) and 4 (2020+).

**Fix.** `sri_entities` (`loc_recovery`) adds `(sri, cc) → entity` wherever all of the SRI's runs *in the crash's county* are one entity. It's tried before the statewide key. Statewide effect (from v4 outputs): 30,293 crashes on 160 (SRI, county) pairs gain a road. JFK's statewide v5 count should be ≈ 36,148 (Hudson v5) + 6 = 36,154.

## Other data fixes

**Retired-SRI calibration** (`calibrate_retired`, new `loc_source` `sri_calib`, `how` `calib` / `calib_xs`).

- **Problem.** Crashes coded with an SRI + MP that today's network lacks (Hudson's pre-2019 county routes: `09000605__` West Side Ave, `09000612__` Communipaw Ave, `09000617__` …) were off every road unless their strings re-located them. That's 40k statewide, 26.6k in Hudson.
- **Anchors.** For each retired SRI, its crashes with a point are anchors: the point recovered from their strings, or NJDOT's / the police's.
  - Anchors are binned per 0.01 mi, and interior outliers (> 150 m off their neighbors' line) are dropped.
  - The SRI needs ≥ 3 anchor bins spanning ≥ 0.1 mi. A stub's anchors all sit at the street it starts on and can't tell its line from the cross street's.
  - Its current SRIs are those within 30 m of ≥ 50% of its anchors.
- **Placement.** A crash's MP is interpolated between the anchors around it: ≤ 0.25 mi apart, and roughly straight (their points ≤ 1.3 × MP distance + 60 m apart). Or it takes an anchor within 0.02 mi. It's then snapped to those SRIs, and refined by its cross street if that meets the road within 200 m.
- **Result.** Hudson: 21,505 placed; Bergen: 462 (few retired SRIs).
- **Precision (5-fold held out).** Held-out anchors re-located from their strings (independent of the calibration) land on the same entity 97.5% of the time: 99.1% of 425 `route_xs`, 89.5% of 86 `intersection`.

**Direction variants** (`road_entities` phase 2): an alias join no longer merges two runs whose names have one `dir_key`. NG9-1-1 aliases Bayonne's "East 48th Street" segments "West 48th Street", and v4 merged the two. Side effect: a crash string without the direction ("48TH ST") now names two entities, so `name_only` can't pick one. Hudson: 882 crashes (0.2%) back off-road. v5.1 places such crashes on the corridor when the candidates are one ([`corridor_only`](#corridor-only)): Hudson 1,467 of 4,212 multi-road-name crashes.

**Placeholder names** (`ng_name`): NG9-1-1 `PRIMENAME` "Unnamed Segment" (26,477 segments), "Unnamed …", "RAMP" and "Driveway" are no names; points there keep NJDOT's SLD name. v4 had 430 entities named "Unnamed Segment". Same-name joins chained unrelated streets: `cape-may/ocean-city/unnamed-segment` spanned 60+ SRIs.

**Route words** (`route_sri`): "WESTERN" / "EXPRESS" fill the SRI's 9th character and "SECONDARY" its 10th. Given the network's SRIs, a "SECONDARY" with no `…S` SRI takes the route's one secondary.

- "I-95 Secondary Western Alignment" → `00000095WS` (v4: `00000095__`, the wrong spur, 81 eval errors).
- "I-78 Secondary" → `00000078_W`.
- Hudson `new` eval `route_xs` precision: 95.1% → 97.9%.

## Overrides

**Format:** `njdot/data/road_overrides.yml`, a list of rules applied in order after entity renumbering (`njdot/road_overrides.py`).

```yaml
- id: jc-broadway-greenville          # unique; recorded in crashes-by-entity.override
  note: >                             # required: the evidence
    NJDOT coded 236 pre-2018 JC "BROADWAY" crashes with Greenville cross streets onto
    SRI 09011544__ at MPs NG9-1-1 names Garfield Ave (2.7-5.5)...
  where:                              # all must hold; ≥ 1 key
    cc: 9                             # values: scalar or list (cc, mc, loc_source, severity)
    mc: 6
    years: [2001, 2017]               # inclusive range (or one year)
    road: '(\d+ )?BROADWAY( \*+)?'    # case-insensitive full-match regex (road, cross_street, sri)
    cross_street: '.*(GATES|NEPTUNE).*'
    entity: hudson/jersey-city/broadway   # the crash's current road (slug, or list)
    mp: [2.7, 5.5]                    # inclusive MP range
  set:
    entity: hudson/jersey-city/garfield-avenue   # a slug, or null: off every road
```

- A rule moves matching crashes to its entity. They keep their SRI / MP / point, and their `chain` is recomputed; it's null if their SRI isn't on the new road.
- `entity: null` drops them from `crashes-by-entity` (they stay in `crashes-by-sri`, with a null `entity`).
- The last matching rule's id goes in `override`. Match counts are logged and stored as JSON in `road-entities`' footer key `overrides`.
- The build raises on an unknown slug, unknown `where` key, duplicate id, or missing `note`.
- **Limit:** rules act on crashes already assigned to a road. A crash recovery left off every road can't be pulled on by a rule. That would need a pre-recovery name rule, which isn't built.

**Seeded empty.** Candidates investigated and why none was added:

| Candidate | Finding |
|---|---|
| JC "BROADWAY" on Garfield Ave | Real: SRI `09011544__` is Bayonne's Broadway continuing into JC as what NG9-1-1 calls Garfield Ave, and pre-2018 JC police called it "BROADWAY". But NJDOT coded 236 of those crashes itself, and recovery already routes the rest correctly or leaves them off: 6 would move. Not worth a rule. |
| Hoboken "ADAMS ST" crashes on the Jefferson St entity | SRI `09051050__` (SLD "ADAMS ST") runs where NG9-1-1 draws Jefferson St. Which source is wrong needs imagery. |
| West Side Ave dip, JFK mismatch, E/W merges, "Unnamed Segment" | Systematic, so fixed in code instead ([Other data fixes](#other-data-fixes)). |

The mechanism is ready for per-road findings from the audit below.

## Anomaly audit

`njdot roads audit-anomalies [-r ROADS_DIR] [-o queue.csv] [-m queue.md] [-n TOP]`, in `njdot/road_anomalies.py`. Ramps are skipped.

- **`yoy`:** runs of years whose count is ≥ 2× off (and ≥ 25 crashes off) the median of the road's ±3 years. Those years are scaled by the rest of its county's total (the road itself excluded), so 2020 isn't flagged. Roads with ≥ 300 crashes. Score: summed Poisson z.
- **`unplaced`:** roads with ≥ 100 crashes, ≥ 30% of them without a map point. Score: count × share.
- **`pair_swing`:** pairs of roads sharing intersections (crashes at a node of both) or one corridor, with ≥ 60 shared crashes, whose per-year share on the first road (years with ≥ 8) spans ≥ 50 points. Score: χ² against the pooled share. Needs v5 outputs.
- **Output:** the queue interleaves the kinds by rank.

### Top findings

**Statewide v4 build** (`yoy`, `unplaced`):

- **NJ Turnpike express lanes, 2023–24 spike, every county** (`bergen/new-jersey-turnpike-express-2` 0 → 196 / 356, Middlesex 156 / 625, Union, Essex, Fort Lee's I-95 Express). AASHTO (2023+) codes crashes to the express-lane SRIs `00000095E_` that per-table years never used. The same crashes leave the main Turnpike (pair swings in Bergen: express vs main 0% → 100%). Corridors merge the two; road pages should show the Turnpike as a corridor.
- **`essex/newark/broadway` 2003–05 spike** (163 / 195 / 196 vs ~30–90), then a 2006–07 dip. Newark's Broadway coding changed twice.
- **`hudson/jersey-city/communipaw-avenue`**: 2014 (114 vs 6) and 2006–07 spikes. Same cause as West Side Ave: Communipaw is retired CR 612, and v5 calibration places `09000612__`.
- **JC `bergen-avenue` 2011–13 dip** (44 / 28 / 31 vs ~110) and **`martin-luther-king-drive` 2014–15 spike**: likely the same JC county-route coding.
- **`bergen/edgewater/river-road` 2010–12 dip** (38 / 0 / 1 vs 115): a road that vanishes for 3 years. Also flagged by the Bergen v5 build.
- **`hudson/kearny/kearny-avenue`**: 126 crashes in 2002, ~15/yr in 2003–18, ~110/yr in 2019+. Kearny's crashes in 2003–18 are mostly elsewhere or unplaced: needs a look.
- **Unplaced:** `hudson/bergenline-avenue` (35% of 8.8k crashes without a point: 615 Union City name-only crashes have no cross street, and those with one don't intersect), `middlesex/edison/old-post-road` 48%, `union/berkeley-heights/horseshoe-road` 49%, `hudson/north-bergen/west-side-avenue` 57%.

**Hudson v5** (`pair_swing`):

- `hudson/j-f-kennedy-boulevard` vs `hudson/jersey-city/communipaw-avenue`: of 629 crashes at their intersections, 100% were on JFK in 2001 and 22% in 2017. This is the county-route attribution convention; inclusive counts absorb it.
- NJ 495 vs its secondary carriageway: 100% in 2019 → 18% in 2023. Holland Tunnel vs I-78: 100% → 8%. I-78 vs Newark Bay Bridge. NJ 3 vs NJ 3 Express. All are AASHTO-era SRI coding changes on multi-carriageway highways, which corridors merge.
- `hudson/kearny/new-jersey-turnpike-west-alignment` 2023–24 spike (94 / 241 vs 15 / 61): the same AASHTO effect.

**Bergen v5:**

- `bergen/essex-street` vs `bergen/maywood/west-essex-street` (4,280 shared crashes; 100% in 2001 → 44% in 2007).
- `bergen/ridgefield/i-95-n-j-turnpike` 2002 spike (215 vs 0).
- `bergen/forest-avenue` 2002–03 dip.

The full queues from the dev builds (`tmp/anom-*.{csv,md}`, not committed) have 1,362 statewide v4 findings, 409 in Hudson, 425 in Bergen and 28 in Hunterdon. **Run the audit on the statewide v5 build** and triage the top ~50 into overrides or code fixes.

## Recovery precision: entity vs corridor

Hudson blind re-location of NJDOT-coded crashes ([`crash-location-recovery.md`] § 4; `tmp/ev.py` + `tmp/ev_cor.py`, 30k samples per mode), scored against NJDOT's own `(sri, mp)`:

| Mode | v4 entities | v5 entities | v5 corridors |
|---|---:|---:|---:|
| `old` (2006–16 strings, names learned 2018+) | 98.19% | 98.16% | **98.66%** |
| `new` (2021+, names learned ≤ 2020) | 96.94% | 97.72% | **98.18%** |

By source (`new`, v5): intersection 97.6% → 97.9% at corridor level; route_xs 97.9% → 98.5%; name_only 97.5% → 98.4%.

- **Entity level.** `new` gains 0.8 points from the route-word fix. `old` loses 0.03 points because direction variants are now separate entities.
- **Corridor level** removes a further 0.5 points of errors: "US 1 Secondary" vs Tonnelle Ave, NJ 495 vs its secondary, direction variants.
- **What remains** is mostly not "same corridor":
  - the I-78 / 12th–14th St / Turnpike Extension tangle in JC (I-78 *is* 12th and 14th Streets there, a one-way pair, not one right-of-way);
  - the Route 505 one-way pair on 37th / 38th Streets;
  - "12TH ST ** / 14TH ST **" strings;
  - NJDOT's own coding (Hoboken Adams / Jefferson).

## Build runtime

v5 as first built. v5.1's numbers are [above](#build-speed).

Laptop, dev builds (wall clock; the laptop's run-to-run noise is ±20%):

| Build | v4 | v5 | of which recovery | of which v5 model | Peak RSS |
|---|---:|---:|---:|---:|---:|
| Hudson `-C 9` (489k crashes) | 44 s | 56–70 s | 30–39 s (v4 29 s) | 7–10 s | 4.2 GB (v4 4.3) |
| Bergen `-C 2` | n/a | 83–113 s | 41–56 s | 16–21 s | 4.7 GB |
| Hunterdon `-C 10` | n/a | 21–27 s | 5–7 s | 2–3 s | 5.0 GB |

The statewide estimate here was **+3–5 min**; the Batch stage actually took 1,906 s (v4 with recovery: 1,429 s).

## Frontend notes

For the separate frontend branch.

- **`LocSource`:** add `sri_calib`. It's placed; badge: "located from a retired route milepost".
- **Road page:**
  - "on this road" = `road-summary.n`; "including intersection crashes" = `n + n_xs`.
  - Crash table: `crashes-by-entity` ∪ `crashes-by-entity-xs` (show `own_entity`'s name for the latter).
  - `node` gives each at-intersection crash its node label (`road-nodes`).
- **Spans:** use `road-blocks` for snapping and block stats, `road-node-entities` for an "Intersections" list (`cross`, `n_crashes`, `n_own`), and the chain range queries above.
- **Corridors:** a road with `corridor` links to its corridor page (`/corridor/<slug>`: members, summary from `road-corridor-summary`, span queries per member).
- **Intersection page:** `road-nodes WHERE node = ?` → its `entities`. Crashes: each entity's `crashes-by-entity WHERE entity = ? AND node = ?` (one entity group each). No `node` stats are needed: filter within the entity's group.
- **Sort:** `entityCrashesSql` should order by `chain` (null last) instead of `sri, mp`.
- **v5.1 blocks:** block-snapped spans filter `block BETWEEN b0 AND b1` (not `chain`), which matches `road-blocks.n_*` / `n_*_xs` exactly; see [Block convention](#block-convention) for recomputing a block from stored values.
- **v5.1 `corridor_only`:** badge such crashes "located to the corridor, not a side"; `road-summary.n_corridor_only` is the per-road count (they're in `n` of the representative member, and in the corridor's counts once).

## Tests

`tests/test_road_model.py` (new):

- direction variants → separate entities + one corridor (synthetic)
- piece order / direction / gaps / branch caps, and `chain_at` incl. secondaries (synthetic)
- `sri_entities` county scope (the JFK case)
- `calibrate_retired` (interpolation, span / near / stub guards)
- `crash_nodes` rules (11 cases: named / flagged / X by class / 150 m cap / geometric / AASHTO / pinned / cross street on no entity)
- `xs_rows` + inclusive `road_summary`
- `road_blocks`
- `ng_name` / `dir_key`
- on the real fixtures: corridors, JFK / West Side pieces, node labels, West Side's per-year `n` / `n_node` / `n_xs`

`tests/test_road_overrides.py` (new): override loading, validation and application; `yoy_breaks` (county-scaled), `unplaced_share`, `pair_swings`, `review_queue`.

Updated:

- `tests/test_roads.py`: the new file set, every file's stats columns, v4-then-v5 column order.
- `tests/test_loc_recovery.py`: route words.

The fixture `tests/data/roads/crashes.parquet` gains `Intersection`. 93 tests pass.

v5.1 adds:

- `test_road_model.py`: `road_blocks` sections, `block_of` / `block_pos`, `block_stats` with `-xs`, `corridor_only_rows`, the multi-road name → candidates in `_locate_one`, and on the fixtures: block counts = crash rows by `block`, with `block` reproduced from the written float32 values.
- `test_roads.py`: the v5.1 files / columns / types; `per_unique`.
- `test_loc_recovery.py`: forked recovery = serial; `CloseMatcher` = `difflib.get_close_matches`.

99 tests pass.

## Build

As [`road-data-v4.md`] § Build: only `www/public/njdot/roads.dvc` needs to run.

```bash
AWS_PROFILE=h batch/submit -j roads-<ts> -b reproc-results/roads-<ts> \
  run -r r2 --no-commit --push each www/public/njdot/roads.dvc
```

Then run `njdot roads audit-anomalies -o tmp/anom.csv -m tmp/anom.md` on the output, and `njdot roads sync` once the frontend is ready.

**Deploy order:** the v5 files are additive and every v4 file keeps working. The one exception is `crashes-by-entity`'s sort: a frontend ordering by `sri, mp` still gets correct rows. The data can ship before the frontend.

## Open questions

- **Corridor ranks.** `road-ranks` is per entity. Split direction variants (White Horse Pike → 4 entities) rank lower than the merged v4 entity did. Add corridor rows to `road-ranks`, or rank corridors separately?
- **Multi-road names off every corridor.** Of Hudson's 4,212 crashes whose road name is several entities', 2,745 stay off-road: the candidates aren't one corridor ("FIRST ST" naming two unrelated streets, a name split across a muni line). A per-muni "most crashes" guess would place some; not done.
- **State-road node offsets.** NJDOT's `I` crashes on state roads sit a median 5–48 m from NG9-1-1 nodes. Worth checking whether NJDOT references intersection MPs to a different point (the far stop bar?) before tightening state-road X.
- **Pre-recovery name overrides.** Rules that rewrite a crash's road string before recovery ("BROADWAY" + Greenville cross street → "GARFIELD AVE") would reach crashes recovery leaves off every road.
- **2019 → 2020+ step on JC roads** (West Side Ave −30% vs −14% statewide): check after the statewide build whether NJDOT's 2019+ coding attributes intersection crashes to cross streets more than before (`n_xs` rose from ~10/yr in 2001–05 to 40–80).

[`road-data-v4.md`]: road-data-v4.md
[`crash-location-recovery.md`]: crash-location-recovery.md
