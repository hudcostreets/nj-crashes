# Crash location recovery (pre-2018 local roads)

Status: **shipped in `njdot roads build`** (branch `loc-ship`; see [Shipped](#shipped-njdot-roads-build)). Needs a statewide Batch `roads build` and the matching frontend deploy. The prototype CLI (`njdot roads recover`) stays for per-county evals. Recovered points on the main map (cells): implemented on branch `cells-recovered`, not yet built ([Map / cells integration](#map--cells-integration)).

## Problem

Road pages show far fewer crashes before ~2018 on local roads. West Side Avenue, Jersey City ([`/road/hudson/jersey-city/west-side-avenue`][wsa]): 0–8 crashes/yr in 2001–2017, then 47, 164, 83, 103, 112, 88 (2018–2023), 130, 111 (2024–25).

`njdot roads build` places a crash on a road entity only through its coded `(sri, mp)` (`assign_crashes`: `mp ∈ [mp_lo, mp_end)` of one of the entity's runs). Before 2018, NJDOT coded an SRI + MP mostly on state and county routes. Municipal-street crashes carry only police-entered strings.

## 1. What the data has

### Fields by year

The raw Crash-table layout is the same in the 2001 and 2017 field specs (`njdot/data/fields/{2001,2017}CrashTable.json`). `crashes.parquet` keeps **every** location field; nothing is dropped:

| raw field | `crashes.parquet` | populated |
|---|---|---|
| Location Direction | `road_direction` | all years |
| Route / Route Suffix | `route` / `Route Suffix` | route-coded crashes |
| SRI / Mile Post | `sri` / `mp` | see coverage below |
| Crash Location (street name) | `road` | ~100%, all years |
| Cross Street Name | `cross_street` | 65–80%, all years |
| Distance To Cross Street / Unit Of Measurement / Direction From Cross Street | `cross_street_distance` / `Unit Of Measurement` / `Direction From Cross Street` | distance on 32–54% (`FE` feet, `MI` miles, `AT` at the intersection); direction N/S/E/W |
| Is Ramp / Ramp To/From Route Name / Direction | `Is Ramp` / `ramp_route` / … | ramps |
| Latitude / Longitude | `olat` / `olon` | 2003–05 (~600/yr), 2006–09 (~165k/yr), 2010 (68k), 2014 (133k), 2017+ (73k–149k/yr); almost only on crashes that also have an SRI |
| (derived) | `ilat` / `ilon` | interpolated from `(sri, mp)` |
| (derived) | `road_system` | 1–4 state, 5–6 county, 7–8 municipal, 9 private property |

AASHTO 2024+ rows carry `road` / `cross_street` but no distance or direction. They're 96% `sri_mp` anyway.

### Coverage per year (statewide)

Categories are exclusive, taken in this order. `sri_mp`: SRI + MP. `sri_only`: SRI, no MP. `latlon`: no SRI but a point. `road_xs`: no SRI or point, but `road` + `cross_street`. `road_only`: `road` alone. `none`: none of these.

| year | n | sri_mp | sri_only | latlon | road_xs | road_only | none |
|---|---|---|---|---|---|---|---|
| 2001 | 312,696 | 43% | 11% | 0 | 33% | 13% | 413 |
| 2003 | 324,053 | 58% | 6% | 0 | 23% | 12% | 202 |
| 2006 | 295,546 | 59% | 6% | 0 | 24% | 11% | 96 |
| 2008 | 303,013 | 56% | 8% | 2 | 24% | 12% | 90 |
| 2010 | 299,575 | 53% | 9% | 5 | 25% | 13% | 61 |
| 2012 | 284,062 | 53% | 10% | 0 | 24% | 13% | 33 |
| 2014 | 290,212 | 54% | 8% | 0 | 25% | 13% | 11 |
| 2016 | 279,874 | 63% | 9% | 0 | 23% | 5% | 2 |
| 2017 | 277,557 | 67% | 7% | 3% | 19% | 5% | 2 |
| 2018 | 284,201 | 73% | 6% | 3% | 15% | 4% | 3 |
| 2019 | 283,198 | 85% | 3% | 2% | 7% | 3% | 2 |
| 2020 | 195,474 | 91% | 1% | 3% | 4% | 2% | 0 |
| 2021 | 226,958 | 90% | 0 | 3% | 4% | 2% | 0 |
| 2022 | 242,550 | 92% | 0 | 3% | 3% | 2% | 0 |
| 2023 | 247,697 | 93% | 0 | 0 | 4% | 3% | 2 |
| 2024 (AASHTO) | 265,827 | 96% | 0 | 3% | 0 | 0 | 4 |
| 2025 (AASHTO) | 261,286 | 97% | 0 | 3% | 0 | 0 | 113 |

By `road_system`, the gap is almost all **municipal** roads. Local rows with `sri_mp`:

- 2001–02: ~5k of ~93k (5%)
- 2003–2017: 17–25k of 80–99k (20–25%)
- 2018: 36k/88k
- 2019: 65k/90k
- 2020–23: 81–88%

Pre-2018, 55–79% of local crashes are `road_xs` and 10–16% `road_only`. County roads are 56% `sri_mp` in 2001 and 69–86% in 2002–17 (+11–29% `sri_only`). State roads are 84–93%. Private property (`road_system` 9, 613k crashes) has an SRI on only 595 crashes, and should stay off roads.

Hudson (cc 9), all classes: `sri_mp` 18–63% in 2001–2017 (just 3.8–6.0k/yr in 2006–2010), then 73%, 89%, 89%, 89%, 89%, 92% (2018–23).

Categorization (DuckDB over `crashes.parquet` ∪ AASHTO 2024+):

```sql
CASE
  WHEN sri <> '' AND mp IS NOT NULL THEN 'sri_mp'
  WHEN sri <> '' THEN 'sri_only'
  WHEN ilat IS NOT NULL OR (olat BETWEEN 38.9 AND 41.4 AND olon BETWEEN -75.7 AND -73.9) THEN 'latlon'
  WHEN trim(road) <> '' AND trim(cross_street) <> '' THEN 'road_xs'
  WHEN trim(road) <> '' THEN 'road_only'
  ELSE 'none'
END
```

## 2. Root cause: West Side Ave

West Side Ave's entity (`41807`) is SRIs `09061684__` (MP 0–1.95; it then becomes Duncan Ave), `09061575__`, `09061725__` and `09061374__`.

- **The main SRI didn't exist in the crash data before 2018.** Crashes with a West-Side-like `road` in JC carry `09061684__` only from 2018 on. Before that, NJDOT's LRS evidently didn't cover the street: only the 0.23 mi stub `09061575__` appears (2–22/yr, mostly *without* an MP).
- **Old crashes carry the name and a cross street, but no SRI, MP or point.** JC crashes with a West-Side `road` string:

  | year | named | sri_mp | sri, no mp | no SRI | no SRI, with cross street |
  |---|---|---|---|---|---|
  | 2006 | 128 | 2 | 0 | 126 | 101 |
  | 2007 | 186 | 1 | 1 | 184 | 151 |
  | 2008 | 122 | 0 | 0 | 122 | 116 |
  | 2010 | 105 | 2 | 4 | 99 | 84 |
  | 2014 | 101 | 2 | 2 | 97 | 88 |
  | 2016 | 131 | 7 | 0 | 124 | 113 |
  | 2019 | 175 | 165 | 0 | 10 | 6 |

  Spellings: "WEST SIDE AVE" (815), "DUNCAN AVE / W SIDE AVE" (352), "WESTSIDE AVE" (316), "WEST SIDE AVENUE" (101), "WESTSIDE AVENUE" (84), "WEST SIDE AVE **", "WESTSIDE", house-numbered ("981 WESTSIDE AVE"). 20–45% also carry "Distance To Cross Street" with a direction. None has `olat`/`ilat`.
- **Some years barely name it.** In 2001–05, 2011–13 and 2017, only 10–37 JC crashes/yr have West Side as their `road`, against 74–188 in 2006–10 and 2014–16, while JC's total crash count is flat.
  - In 2011–13 and 2017, West Side still appears as the *cross street* 100–148 times/yr. JC intersection crashes were recorded with the other street as `road`, mostly a county route (CR 612/605/617 counts in 2012 are 2–3× their 2008 level).
  - In 2001–05 it's rare as either `road` or cross street (8–37/yr). Probably the same attribution to intersecting routes: JC had ~60% SRI-coded crashes then, like 2011–13. This is unexplained beyond that. No string-based recovery can move those crashes onto West Side without contradicting how 2018+ crashes are attributed (by `road`). That cap is shown in the "named road" column below.

## 3. Recovery strategies

All strategies key on normalized names:

- `loc_key` normalizes ordinals ("THIRTY-NINTH", "39 TH" → "39TH"), "MLK", "JOHN F", `JR`, doubled letters (digits kept), abbreviations and directions.
- `clean_road` strips house numbers, `**`, "PARKING LOT" and punctuation.
- `split_road` turns "A / B" into road A + cross B.
- `resolve_keys` looks keys up per muni, trying in order:
  - exact;
  - `base_key` (type-less: "WESTSIDE" → "WESTSIDEAVE", only when unique);
  - `nodir_key` ("3RD ST" → both "N 3RD ST" and "S 3RD ST", left for the cross street to pick);
  - fuzzy (`difflib` ≥ 0.88, with a clear winner: "AUDIBON" → "AUDUBON").

Route strings get their own handling:

- "US 1 & 9", "RT 440", "ROUTE 501", "HUDSON COUNTY 617" → `route_sri`, i.e. NJDOT's SRI (`00000001__`, `00000501__`, `09000617__`).
- The same strings → `route_keys` → NG911 shield keys (`R:US1`, `R:CR617`). This is for retired SRIs.

The NG911 name index is `ng_name_index`: segment × (county, muni from either side via `road_outputs.muni_codes`) × {primary name, abbreviated name, local `L` aliases, shields}.

- **(a) name only.** Road name + muni → one entity:
  - **learned** (`learn_names`): `(cc, mc, road key) → entity` from crashes NJDOT *did* code. The top entity must hold ≥ 80% of ≥ 5 coded crashes. This catches "COLUMBUS DR" → Christopher Columbus Dr and "ROUTE 501" → Kennedy Blvd. Else:
  - **NG911**: the name's segments (primary names first, then aliases) all lie on one entity (`seg_entities`: each segment's `ng_intervals` SRI interval → `entity_at` the published runs).
- **(b) intersection.** Road segments ∩ cross-street segments in the muni (`meet_points`, ≤ 5 m; NG911 is noded). The cross street falls back to the county if it's not in the muni.
  - The meets group into **junctions** (`junctions`; [`road-anomalies.md`] § R2-1): distinct meets chained within 300 m, each group within 150 m of its meet-weighted mean (a divided road's carriageways, a triangle junction). A junction's point is that mean if it's on the road (≤ 30 m), else the group's meet nearest it. A group spread wider is the road running along the cross street: no junction.
  - The point then moves `distance` along the road in the reported direction (`offset_along`: along any road line through the point, so a node where the nearest segment ends doesn't block it). No direction: allowed up to 200 ft.
  - Several junctions (a crescent, a road meeting the cross street at both ends, two same-named streets): the one from which the offset / direction leads onto the road's NJDOT lines. With several such (no direction, or both possible) the crash isn't placed by the intersection (`how` = "junctions" if nothing else places it).
  - It then snaps to the road's **own** SRIs only (`Snapper`, ≤ 30 m). At an intersection the cross street's line is equally near.
  - Result: lon/lat + SRI + MP.
- **(b′) route + cross street** (`route_xs`): the same, with a route string's NJDOT lines as the road.
- **(c) lat/lon snap** (`latlon_snap`): a reported point (`ilat`/`ilon`, else `olat`/`olon` inside NJ) snaps to the road's SRIs (≤ 30 m).
- **(d) SRI without MP** (`sri_only`):
  - First, (b′) with the cross street gives an MP.
  - Else, if every run of the SRI is one entity (most local SRIs), the crash gets that entity.
- **(d″) coded, but towns away** ([`road-anomalies.md`] § R2-7): a coded crash whose `(sri, mp)` lands > 2 km from its muni, on a road that doesn't come near it (re-mileposted routes: CR 509 in Paterson, CR 624 in Elizabeth), is re-located like a retired-SRI crash, else kept as coded; before recovery, 2001–02 county-route crashes coded to the same-numbered state SRI get the county SRI (§ R2-4).
- **(d′) retired SRIs.** Crashes coded with an SRI that's no longer in the network are re-located like uncoded ones, keeping their coded SRI/MP if that fails. This affects 2–7k crashes/yr statewide before 2019. In Hudson it's big: the pre-2018 county-route SRIs `09000617__` / `612` / `605` … aren't in today's network at all. For example, `09000617__` has 3,151 pre-2018 crashes, none on an entity.

Guards:

- **(i)** Private property (`road_system` 9) is never recovered.
- **(ii)** "A / B" `road` strings aren't used for name-only or intersection. The 2018+ coded ones sit on A only 74–91% of the time.
- **(iii)** If the named cross street exists but never meets the named road, there's no name-only fallback. One of the names is wrong, e.g. "BROADWAY & CARTERET AVE" in JC, which NG911 calls Garfield Ave there.
- **(iv)** Princeton Boro/Twp and Port Authority / geocoded crashes need no special case. Matching uses the crash's *canonical* `cc`/`mc` (the site's codes, which NG911 munis map to), and `mc_dot` isn't involved. Princeton's merged `mc` = NG911's single "Princeton".

## 4. Prototype results (Hudson)

`njdot roads recover -C 9 [-e N -m new|old|ll] [-o out.parquet]` (`njdot/cli/loc_recovery.py`). It reads the published `road-runs.parquet`, so entity ids match the live `roads/` outputs. Runtime is ~70 s on the laptop for Hudson's 489k crashes.

### Precision (blind re-location of crashes NJDOT coded)

Coded crashes get their SRI/MP/points blanked, and names are learned only from other years. `entity_ok` means the same entity as NJDOT's `(sri, mp)`. `d` is the distance to NJDOT's point.

**`old`** (2006–16, police-entered strings), local-SRI crashes with a cross street:

| source | share | entity_ok | median d | p90 d | median \|ΔMP\| |
|---|---|---|---|---|---|
| intersection | 65% | **98.1%** | 3 m | 80 m | 0.001 mi |
| name_only | 27% | **97.5%** | – | – | – |
| none | 8% | – | – | – | – |

Over all of `old` (incl. highways without cross streets), `route_xs` is 98.0% (median 5 m).

**`new`** (2021+, names learned ≤ 2020), all 29,846 coded:

| source | share | entity_ok | median d | p90 d |
|---|---|---|---|---|
| intersection | 41% | 97.6% | 10 m | 135 m |
| route_xs | 24% | 95.3% | 10 m | 172 m |
| name_only | 8% | 97.2% | – | – |
| sri_only | 0.1% | 100% | – | – |
| none | 27% | – | – | – |

**`ll`** (2017+, police `olat` only, cross street blanked): `latlon_snap` covers 64% at 96.9% (99.3% on local SRIs, 91–95% on state highways, where parallel carriageways / ramps sit within 30 m).

The residual errors I looked at are mostly:

- co-signed SRIs: Tonnelle Ave vs US 1 lines, both 30 m away;
- E/W-named street pairs the build merges into one entity ("West 48th St" incl. East 48th): a build question, not a recovery error;
- NJDOT's own coding in the ground truth ("BROADWAY" coded on an SRI NG911 calls Garfield Ave).

Hand spot-check of 45 random pre-2018 recoveries (15 each of intersection / name_only / route_xs): all consistent with their strings. Two name_only cases were debatable ("THIRTY-SECOND STREET" → Hackensack Plank Rd via an NG911 alias; "EAST 30 TH ST" → the merged "West 30th Street" entity).

### Recall

Hudson, non-private crashes on an entity:

| year | before | after | …with a point |
|---|---|---|---|
| 2001 | 27.0% | 75.1% | 53.9% |
| 2003 | 44.3% | 77.8% | 61.2% |
| 2006 | 22.8% | 76.9% | 56.9% |
| 2008 | 23.7% | 76.8% | 57.6% |
| 2010 | 22.8% | 75.1% | 55.6% |
| 2012 | 41.2% | 74.4% | 60.4% |
| 2014 | 29.5% | 78.2% | 58.9% |
| 2016 | 39.7% | 81.6% | 65.8% |
| 2017 | 51.5% | 77.0% | 65.9% |
| 2018 | 64.9% | 84.6% | 76.8% |
| 2019 | 91.1% | 97.8% | 95.2% |
| 2023 | 93.2% | 97.5% | 95.6% |

Pre-2018, by class: municipal roads go from 13.1% to 76.2% on an entity, county 57.9% → 76.5%, state 73.3% → 77.7%.

77k pre-2018 Hudson crashes remain off-entity:

- 26k keep a retired-SRI coding that couldn't be re-located (mostly state highways with no cross street: Turnpike, I-78, US 1/9, NJ 440, whose old SRI + MP don't fit today's network).
- 50k are `none`. Of those, 16k are on state roads and 26k have no cross street. The rest are unresolvable names ("PRIVATE LOT", "TARGET LOT", misspellings beyond the fuzzy cutoff), streets that never meet their cross street, and "A / B" strings.

West Side Ave (entity 41807). "Named road" / "named cross" count JC crashes whose `road` / `cross_street` looks like West Side. They're the cap from §2.

| year | before | after | with point | name/SRI only | named road | named cross |
|---|---|---|---|---|---|---|
| 2001 | 0 | 23 | 5 | 18 | 34 | 26 |
| 2005 | 0 | 21 | 3 | 18 | 37 | 20 |
| 2006 | 2 | 108 | 71 | 35 | 128 | 95 |
| 2007 | 1 | 164 | 115 | 48 | 188 | 128 |
| 2008 | 0 | 103 | 83 | 20 | 122 | 148 |
| 2009 | 2 | 79 | 62 | 15 | 93 | 129 |
| 2010 | 2 | 97 | 66 | 29 | 105 | 123 |
| 2011 | 8 | 27 | 4 | 15 | 36 | 100 |
| 2012 | 1 | 8 | 1 | 6 | 16 | 101 |
| 2013 | 2 | 16 | 4 | 10 | 19 | 118 |
| 2014 | 2 | 95 | 64 | 29 | 101 | 141 |
| 2015 | 4 | 66 | 43 | 19 | 74 | 104 |
| 2016 | 7 | 128 | 90 | 31 | 131 | 114 |
| 2017 | 2 | 5 | 1 | 2 | 10 | 148 |
| 2018 | 47 | 53 | 1 | 5 | 59 | 134 |
| 2019 | 164 | 172 | 2 | 6 | 175 | 144 |
| 2022 | 112 | 123 | 8 | 3 | 136 | 99 |

### Statewide estimate

Name resolution alone (`split_road` → `loc_key` → `resolve_keys` against a statewide `ng_name_index`, ~70 s) was run statewide. It covers 1.39M non-private no-SRI crashes 2001–2023; learned names, `nodir` and route keys weren't included yet.

- Local roads: 94% of road names resolve to an NG911 name in the crash's muni (exact 89%, base 2.4%, fuzzy 2.3%), and 64% resolve both road and cross street. That ranges from 59% (2001) to 69% (2014).
- Top misses:
  - misspellings ("TWENIETH", "EIGHT ST");
  - "N/S 3RD ST" type pairs, handled now by `nodir`;
  - route-designation cross streets ("US 1", "CR 501"), handled now by `route_sri` / `route_keys`;
  - names missing from NG911 ("COMMERCIAL AVE", 779).

Applying Hudson's conversion rates per (class × road-resolved × cross-resolved) bucket to statewide pre-2018 counts:

- local: 1.13M → ~1.00M on an entity (89%), ~620k with a point + MP;
- county: 96k → ~72k;
- state: 20k → ~5k.

That's +1.08M crashes on road entities, against 2.85M coded pre-2018 non-private crashes today.

Hudson is urban and gridded. Rural munis with sparse cross streets or poorer NG911 names will convert less, so treat the estimate as an upper-middle bound until the statewide run.

## 5. Recommendation

Ship strategies **(b)/(b′) intersection**, **(a) name only (learned first, then NG911)**, **(d) SRI-only / retired SRI** and **(c) lat/lon snap**, all in one pass (`recover`), with provenance. Precision is 97–98% entity agreement on both old- and new-format strings. That's comparable to the build's own run-assignment noise at co-signed / merged roads. It lifts Hudson pre-2018 from ~30% to ~77% of crashes on a road, and makes West Side Ave's 2006–10 and 2014–16 counts line up with 2018+.

Don't try to push past what the strings name: the 2011–13 / 2017 West Side gap is a reporting convention, not missing geometry. See Open questions.

## 6. Output design

Add a **`loc_source`** column (dictionary string) to `crashes-by-entity` and `crashes-by-sri`:

| `loc_source` | `sri` / `mp` | `lat` / `lon` | map point | meaning |
|---|---|---|---|---|
| `sri_mp` | coded | NJDOT's | yes | as today |
| `intersection` | recovered | recovered | yes | road ∩ cross street (+ offset), snapped to the road |
| `route_xs` | recovered | recovered | yes | route string / SRI-without-MP ∩ cross street |
| `latlon_snap` | recovered | reported | yes | reported point snapped to the road |
| `sri_only` | coded SRI, no MP | null | **no** | SRI is a single entity |
| `name_only` | null | null | **no** | road name + muni is a single entity |

Details:

- Name-only / SRI-only rows sort last within their entity (`sri`/`mp` NA; `(entity, sri, mp, dt, id)` with `na_position='last'`). The table lists them with an "approximate: street name only" badge.
- Map layers (`sri-hit`, cells) only draw rows with a point. The road-page crash list says "N more located by street name only (no map point)".
- `road-summary{,-monthly}` / `road-entities.n_*` / `road-ranks` count **all** entity-assigned crashes. Otherwise the pre-2018 undercount stays, and per-year plots and per-mile ranks remain biased toward 2018+.
- Add `n_unplaced` (name_only + sri_only) to `road-summary` for a hatched / lighter bar segment, so the site can show which part of a year's count has no point.
- `road-ranks` counts by the crash's own `cc`/`mc`, which name-only crashes have.
- Per-mile ranks shift: pre-2018 volume rises on municipal roads. That's the point of the change.
- Also keep **`how`** (`exact`/`base`/`nodir`/`fuzzy`/`learned`/`route`) in `crashes-by-sri` only, for audits. It's not needed in the lean `crashes-by-entity`.

For the main map (cells), a crash-level sidecar: implemented as `njdot/data/crash_recovered_points.parquet`, a `roads build` co-output applied by `_build_base` (not by `load_crashes_with_aashto`, which `roads build` reads too); see [Map / cells integration](#map--cells-integration).

Entity ids are build-specific, so name-only assignments stay inside `njdot roads build`.

## 7. What it takes to ship

- **No crashes-level reproc.** `crashes.parquet` already has every input (`road`, `cross_street`, distance / unit / direction, `road_system`, `olat`/`ilat`). No Batch run of `njdot compute pqt` is needed.
- **`njdot roads build`** (Batch, as now):
  - add the extra columns to its crash load;
  - after `build_geom`, run `ng_name_index` + `seg_entities` + `learn_names` + `recover` on the crashes not on an entity;
  - fold placed ones into `by_sri` / `assign_crashes`, and append name-only / SRI-only rows to `by_entity`.

  Statewide `ng_intervals` / `ng_segments` are already computed there, so reuse `b['seg']`, `b['iv']` and the build's own `runs`. Estimated extra runtime: minutes; the per-crash loop is memoized by `(muni, names, offset)`. Deps are unchanged: crashes, AASHTO, NG911 and the network are all already inputs of `roads-build`.
- **Map / cells (second step):** a sidecar the map / cells stages depend on; done as a `roads build` co-output ([Map / cells integration](#map--cells-integration)). That triggers one cells rebuild on Batch.
- **FE:**
  - `loc_source` badge in the road crash table;
  - "N by name only" note;
  - optional hatched `n_unplaced` in the per-year plot.
- **Tests:** `tests/test_loc_recovery.py` (11 tests; exact equality; real-fixture end-to-end on West Side / Duncan / JFK Blvd).

## Shipped (`njdot roads build`)

### Pipeline

- **Crash load** (`load_build_crashes`): `MAP_INPUT_COLS` + `id` + `RECOVERY_COLS` (`road_system`, `cross_street_distance`, `Unit Of Measurement`, `Direction From Cross Street`); `prep_crashes` normalizes their types across the per-table ∪ AASHTO concat. AASHTO names its road systems: `road_system_codes` maps "Private Property" → 9 (the only code recovery checks), others → NA.
- **Recovery pass** (`place_crashes`, after `build_geom`): `recovery_context` builds `recover`'s inputs from the build's own NG911 segments (`b['seg']`), accepted intervals (`b['iv']`), runs (`b['runs']`, pre-renumbering entity ids) and NJDOT features (`b['feats']`, newly returned by `build_geom`). `recover_unassigned` finds the crashes whose coded `(sri, mp)` puts them on no run (`entity_at`), learns names from the rest (`learn_names`, all years), and runs `recover` on them. `fold_recovery` folds the result into the crash frame:
  - placed (`intersection` / `route_xs` / `latlon_snap`): the recovered SRI / MP replace the crash's; point = the recovered one for `intersection` / `route_xs`, the reported one (as before) for `latlon_snap`. They then go through `crashes_by_sri` → `assign_crashes` like coded crashes.
  - `sri_only` / `name_only`: entity from `recover`, no MP and no point (`lat` / `lon` dropped even when a police point exists that didn't snap within 30 m). `entity_crashes` appends them to `by_entity` (no `run`); `sri_only` ones are also in `crashes-by-sri`.
  - everything else keeps its coding (`loc_source` `sri_mp`, or `none`).
- **Crash-reported aliases** (`stretch_aliases`) use only `sri_mp` crashes: recovered ones were placed *by* their names and would echo them back.
- `roads build -R/--no-recover` skips the pass; `-c` (reuse a `crashes-by-sri`) has no uncoded crashes, so it skips it too. `-C/--county N` is a dev subset (the county's crashes, NG911 segments and nearby NJDOT lines, via `county_subset`, shared with `njdot roads recover`).
- Perf: `entity_at` is now a `merge_asof` (run intervals don't overlap on an SRI), not a crash × run merge; `recover`'s per-crash loop reads plain arrays; `sri_lines` groups features once. Coded crashes land on exactly the entities `assign_crashes` gives them (Hudson: all 181,996 `id`'d coded crashes identical, same entity and point, with and without recovery).

### Outputs

- `crashes-by-entity`: + `loc_source` (dictionary string); sorted `(entity, unplaced, sri, mp, dt, id)`, unplaced last.
- `crashes-by-sri`: + `loc_source`, `how` (audit; null on coded crashes).
- `road-summary{,-monthly}`: `n` counts all assigned crashes; + `n_unplaced`.
- `road-entities.n_*`, `road-ranks`: count all assigned crashes (ranks by the crash's own `cc` / `mc`).
- Schemas: [road-data-v4.md](road-data-v4.md).

| `loc_source` | on entity via | `sri` / `mp` | `lat` / `lon` | in `crashes-by-sri` |
|---|---|---|---|---|
| `sri_mp` | coded SRI / MP | coded | NJDOT's | yes |
| `intersection` | recovered SRI / MP | recovered | recovered | yes |
| `route_xs` | recovered SRI / MP | recovered | recovered | yes |
| `latlon_snap` | recovered SRI / MP | recovered | reported | yes |
| `sri_only` | the SRI's one entity | SRI, null MP | null | yes |
| `name_only` | the name's one entity in the muni | null | null | no |
| `none` | not on an entity | as coded | as before | if it has an SRI |

### Hudson (`roads build -C 9`, laptop)

Recovery tried 261k of 489k crashes (+43 s; whole build 29 s → 67 s, peak RSS 3.7 → 4.5 GB). `crashes-by-entity` 228.0k → 382.4k rows (65.6k without a map point); `crashes-by-sri` 301.8k → 382.4k.

West Side Ave (`hudson/jersey-city/west-side-avenue`), crashes per year, before → after (of which no map point):

| 2001 | 2002 | 2003 | 2004 | 2005 | 2006 | 2007 | 2008 | 2009 | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 → 23 (18) | 0 → 14 (13) | 5 → 19 (14) | 4 → 27 (19) | 0 → 21 (18) | 2 → 108 (35) | 1 → 164 (48) | 0 → 103 (20) | 2 → 79 (15) | 2 → 97 (29) | 8 → 27 (15) | 1 → 8 (6) | 2 → 16 (10) | 2 → 95 (29) | 4 → 66 (19) | 7 → 128 (31) | 2 → 5 (1) | 47 → 53 (5) | 164 → 172 (6) | 83 → 87 | 103 → 107 (1) | 112 → 123 (3) | 88 → 94 | 130 | 111 |

Hudson county-wide `road-ranks` top 5 by crashes: JFK Blvd 27,121 → 36,127; NJ Turnpike 17,723 → 17,737; Tonnelle Ave 14,400 → 16,139; Pulaski Skyway 9,521 → 9,961; **Bergenline Ave enters at #5 (8,804)**, pushing NJ 440 (6,562 → 7,211) to #6. Per mile: JFK Blvd enters the top 5 (#3, 2,542/mi), the Turnpike drops out.

### Runtime (statewide estimate)

Hudson's pass is 43 s for 261k crashes tried. Statewide ≈ 7.1M crashes − 4.55M coded-on-entity ≈ 2.5M tried: ~7 min if the per-crash memo hits as often as in Hudson, plus ~1–2 min for the statewide name index / fuzzy resolution; budget **5–15 min** on Batch. Memory: +~1 GB in Hudson; statewide the recovery frames (2.5M rows) and name index add a few GB. `roads.dvc` asks for `mem_gb: 16`; watch the first Batch run's peak.

### Frontend

- `roadsData.ts`: `LocSource`, `isUnplaced`; `fetchEntityCrashes` / `fetchEntitySummary` select `COLUMNS('^(…)$')`, so pre-recovery files (no `loc_source` / `n_unplaced`) still load; `entityCrashesSql` orders `mp IS NULL, sri, mp, dt`. `RoadCrash.sri` is nullable.
- Road table: unplaced rows last (both orders), with a "street name only" / "route only" badge whose explanation is an MUI `Tooltip`. CSV export gains `loc_source`.
- Road page and map panel: "N crashes located by street name or route only (no map point)" (from `road-summary.n_unplaced`), when N > 0.
- `RoadPlots`: each severity's unplaced part stacks on its placed part, faded + hatched, with a caption; hover gives the severity total and "(N no map point)". `YearStrip`: faded segments, readout "(N no map point)".
- Map points: `RoadMap` already drops crashes without `lat` / `lon`; `useRoadSelection`'s layers are paths only.
- Known gap: the crash page's "on road" link (`fetchCrashEntity`) looks the crash up in `crashes-by-sri` by its *coded* SRI, so recovered crashes (no or retired coded SRI) show no road link.

### Deploy order

The frontend must ship **before or with** the new road data: the current frontend's crash table does `r.sri.replace(…)` on every row of a multi-SRI road, and `name_only` rows have a null `sri`, so the road page / panel of e.g. West Side Ave would throw. The new frontend works on both old and new files (checked against the published statewide files and the Hudson build).

## Open questions

- **"Road" vs "cross street" attribution (decided: no double-counting).** An intersection crash (no offset) is equally on both streets. NJDOT (2018+) attributes by `road`, so recovery does too. In years where a muni recorded the other street as `road` (JC 2011–13 / 2017 for West Side), road pages still dip. Options were: accept it; count intersection crashes on both roads' pages (breaks "sum of roads = total"); a per-muni-year heuristic. **Decision: accept it.** Each crash is on at most one road, and nothing extra is exposed (no "also at this intersection" count); the dip is documented here.
- `learn_names` thresholds (5 crashes, 80%) are untuned. A statewide holdout eval (`-m new`) per county would tune them and check how Hudson's precision transfers.
- The E/W-merged entities ("West 48th Street" containing East 48th) come from `road_entities`, not from here.

## Map / cells integration

Status: **implemented** on branch `cells-recovered`, not yet built statewide or deployed. Recovered points reach the main map (S2 cells / heatmap) through a sidecar that `roads build` writes and the map-facing exports apply.

### Sidecar: `njdot/data/crash_recovered_points.parquet`

A second output of `njdot roads build` (`map_points` in `njdot/cli/roads.py`), declared as a co-output stage `njdot/data/crash_recovered_points.parquet.dvc` (same cmd as `www/public/njdot/roads.dvc`, so dvx runs the build once for both). It's a new dep of `data/cells/raw/s2_l21.dvc` and `www/public/njdot/map.dvc`, never of `roads.dvc`: recovery must see NJDOT's points only (the circularity risk above), so `_build_base` applies it only when a caller passes it, and `roads build` doesn't. Consequence: `roads build` is now upstream of cells (they were siblings).

One row per crash whose map point recovery changes (`map_base.RECOVERED_COLS`):

| column | type | |
|---|---|---|
| `id` | int64, null | the crash's `id`; null on AASHTO (2023+) rows, which have none |
| `year`, `cc`, `mc`, `case` | int16, int8, int16, string | |
| `dt`, `road`, `cross_street` | timestamp, string, string | AASHTO rows only: with the four above, their key (`RECOVERED_KEY`) |
| `kind` | string | `recovered` / `corrected` / `dropped` |
| `loc_source` | string | the build's (`intersection`, `route_xs`, `sri_calib`, `sri_mp`, `latlon_snap`, `name_only`, …) |
| `lat`, `lon` | float32 | the new point (null when `dropped`) |

- **Keys.** Per-table rows join on `id`. AASHTO rows have no `id`, and `(year, cc, mc, case)` isn't unique among them (1,595 duplicate keys: the same crash reported twice, typically once with a point and once without), so they join on `(year, cc, mc, case, dt, road, cross_street)` (226 duplicates left). A key whose crashes' outcomes differ is left out, so its crashes keep NJDOT's points; a key whose crashes all come out the same is written once.
- **Deterministic**: sorted `(id, *RECOVERED_KEY)` (AASHTO last), zstd, no pandas / arrow schema metadata (`write_recovered_points`; the test writes it twice and compares bytes).
- **Size**: Bergen 116.5k rows / 1.5 MiB, Essex 121.2k / 1.5 MiB (`roads build -C 2` / `-C 7`); statewide ≈ 1.05M rows, **≈ 13–14 MiB**.

### Precedence

After recovery, a crash's map point is the first of (`map_points`):

1. **NJDOT's** (`interpolated`, else `original`), unless judged wrong:
   - `recoded`: `recode_county_routes` (2001–02 county routes coded to the state route's SRI) or a curated `recode` rule dropped it (`drop_coded_points`: computed from the SRI / MP being replaced);
   - coded towns from the crash's muni, **re-located** by recovery, with NJDOT's point out of town too (`far_from_town` on it; R2-7). Not re-located, NJDOT's coding stands (the muni may be what's wrong: Essex Fells's Parkway crashes), and so does its point.

   A distinct police point survives either (`drop_coded_points` only drops `olat` / `olon` when they equal `ilat` / `ilon`).
2. **Recovery's** (`intersection` / `route_xs` / `sri_calib`; `latlon_snap`'s point is the reported one).
3. A **recoded** crash still on its (now county-route) SRI / MP: that SRI / MP's point on today's network (`Snapper.point`). Without this, Bergen's 2001–02 "CR N" crashes drawn on NJ N would just vanish.

`kind` compares it with the map's point today (`effective_points` before recodes): none → a point is `recovered`; a point → another is `corrected`; a point → none is `dropped`. `_build_base(df, keep_severities, recovered=…)` applies them: `recovered` fills only (NJDOT's point wins if a stale row meets one), `corrected` overrides, `dropped` removes. `geocode_src` gains `recovered` and `corrected` (`GEOCODE_SRCS`).

Deliberate differences from the road pages:

- A police point that didn't snap to the crash's named road (`sri_only` / `name_only`) stays on the map. `fold_recovery` drops it from `crashes-by-entity` (the road page shows the crash without a point), but it's independent evidence, and NJDOT's interpolated points aren't second-guessed on the map either.
- Crashes re-located from a retired SRI whose NJDOT point (computed on the network of its day) isn't judged wrong keep that point on the map; the road page shows recovery's. Statewide ~51k crashes are placed by recovery while having an NJDOT point (23.6k `intersection`, 19.5k `route_xs`, 7.7k `sri_calib`); only the judged-wrong ones (~12k, below) move.

Risk (from the pre-implementation review): ~2–3% of recovered points are on the wrong road (97–98% precision), and intersection points sit at the intersection ± offset. Fine for per-road counts, more visible as heatmap mass, where they look as authoritative as NJDOT's; `geocode_src` keeps them distinguishable if the UI ever needs to.

### County checks (`roads build -C N`, laptop)

| | Bergen `-C 2` | Essex `-C 7` |
|---|---|---|
| recovered | 115,176 | 115,934 |
| corrected | 1,128 (982 recoded → re-interpolated, 123 `route_xs`, 23 `sri_calib`) | 5,251 (towns away, re-located: 4,377 `route_xs`, 686 `sri_calib`, 187 to the police point) |
| dropped | 214 (recoded, SRI / MP on no current line) | 2 |
| sidecar step | 0.6 s (whole build 76 s, peak RSS 3.3 GB) | 0.5 s |

Bergen's 982 corrected `sri_mp` points moved a median 97 km (4 of 982 were in Bergen before, all 982 after). Applied through the cells load path (`load_crashes_with_aashto(MAP_INPUT_COLS + ['id'])`, Bergen rows), every sidecar row matched, AASHTO keys included: Bergen map points 446,536 → 561,498 (+25.7%).

### Statewide impact (estimate)

From the published statewide roads outputs (`roads-20260927-182127`) against `crashes.parquet` ∪ AASHTO (`recovered` only; `corrected` / `dropped` need the build's recode / out-of-town masks): **~1.03M crashes gain a map point** (837k `intersection`, 165k `route_xs`, 30k `sri_calib`; 651 fatal, 233k injury, 799k PDO), on top of 4.44M drawn today (+23%). Corrected: ~12k statewide (Essex 5.3k, Union ~4.1k and Passaic ~0.7k by R2-7's re-located counts, Bergen 1.1k); dropped: a few hundred.

| year | map now | + recovered | |
|---|---:|---:|---:|
| 2001 | 123,911 | 84,980 | +69% |
| 2002 | 141,534 | 75,538 | +53% |
| 2003 | 176,849 | 55,361 | +31% |
| 2004 | 179,853 | 52,352 | +29% |
| 2005 | 174,108 | 50,458 | +29% |
| 2006 | 172,839 | 48,911 | +28% |
| 2007 | 178,433 | 51,358 | +29% |
| 2008 | 170,507 | 51,363 | +30% |
| 2009 | 164,956 | 53,863 | +33% |
| 2010 | 155,514 | 57,543 | +37% |
| 2011 | 150,450 | 55,320 | +37% |
| 2012 | 144,305 | 53,749 | +37% |
| 2013 | 145,491 | 57,165 | +39% |
| 2014 | 155,616 | 54,978 | +35% |
| 2015 | 159,967 | 58,251 | +36% |
| 2016 | 168,265 | 58,398 | +35% |
| 2017 | 189,816 | 46,333 | +24% |
| 2018 | 207,260 | 37,436 | +18% |
| 2019 | 233,879 | 14,418 | +6% |
| 2020–25 | 1,247,976 | 15,203 | +1% |

By county: Hudson 123.6k, Essex 115.9k, Bergen 115.1k, Middlesex 112.1k, Passaic 97.0k, Union 70.6k, Ocean 62.1k, Monmouth 58.9k, Mercer 52.2k, Camden 42.2k, Morris 36.6k, Somerset 27.2k, Atlantic 21.5k, Burlington 21.3k, Gloucester 16.7k, Cumberland 13.3k, Cape May 12.9k, Warren 11.1k, Hunterdon 9.7k, Sussex 9.1k, Salem 3.6k.

**Heatmap effect.** The map's pre-/post-2018 discontinuity mostly closes: 2001–2018 gain 18–69% (municipal streets go from nearly empty to populated), 2019+ ≤ 6%. West Side Ave (JC) map points per year: 0–5 in 2001–2017 → 102–192 recovered (2011–13: 154 / 127 / 148; 2017: 179), vs 79–151 coded in 2019–25. The 2011–13 / 2017 gap of §2 is filled too: those years' West Side crashes are mostly coded to its retired county-route SRIs ("HUDSON COUNTY 605 / 641") and placed by calibration (`sri_calib`, R2-8), e.g. 2012: 127 recovered points. Year-over-year comparisons of pre-2019 heatmaps change accordingly (the point, but worth a note in the map UI).

**Cells size** (recovered points' S2 cells ∪ today's raw `s2_l21`): distinct cells across l4–l21 4.04M → 5.22M (+29%; l21 1.03M → 1.39M, l17 +26%, l13 +3%, l11 and coarser ~0), so `cells-s2.db` ≈ 403 → ~520 MB (D1 rows +29%), `s2-sld.parquet` (git-tracked) ≈ 28 → ~36 MB; pyramid `(cell, year)` rows 13.8M → 17.7M (+28%), ≈ 490 → ~625 MB; raw shards 4.44M → ~5.47M rows (≈ 88 → ~108 MB).

### `geocode_src` downstream

The raw shards (`raw/s2_l21/*.parquet`) carry `geocode_src` per crash, so `recovered` / `corrected` land there for free. The pyramid and `cells-s2.db` aggregate counts only, and the worker serves only those; nothing downstream reads `geocode_src`. A per-cell `n_recovered` (pyramid + D1 column, worker `fields`, a tooltip "N located from street names") is left as a follow-up: an extra count column on every pyramid / D1 row for a caption.

### Rebuild order (Batch)

1. `www/public/njdot/roads.dvc` + co-output `njdot/data/crash_recovered_points.parquet.dvc`: one `njdot roads build` (last statewide run 555 s; `mem_gb: 16`; the sidecar step adds seconds and ~0.5–1 GB for the pre-recode keys / points). `roads.dvc` is stale anyway (`roads.py` / `map_base.py` git_deps); its outputs don't change on this branch.
2. `data/cells/raw/s2_l21.dvc` (60 s on Batch, 2026-09-25; no `mem_gb` hint).
3. `njdot compute cells sld` → `data/cells/s2-sld.parquet`: not a dvx stage (git-tracked, run by hand; needs `nj_mp_tenths.parquet` + the muni geojson). Without it, the ~1.2M new cells have null `sld_name` / `mun` labels in the pyramid / D1.
4. `data/cells/s2_pyramid.dvc` (156 s on the laptop before phase 8; +28% rows) and `data/cells/cells-s2.db.dvc` (15 s on Batch).
5. `www/public/njdot/map.dvc` (`export_map_v2`: county / muni fit-bboxes + year range; cheap, bboxes shift slightly).
6. Publish: `njdot compute cells manifest` + `njdot compute cells push` (R2 pyramid + raw; bumps `data_version`), then `api/d1-import.dvc` (`d1-import.sh --inplace … cells-s2`; ~5.2M rows). No worker or frontend change is needed.

### Tests

`tests/test_map_points.py` (exact equality): `recovered_points` kinds and AASHTO keys (shared keys, same / different outcomes); `_build_base` precedence (fill / correct / drop / stale `recovered` loses to NJDOT / AASHTO key match / no match on another road); byte-identical rewrite + read-back; `map_points` precedence (recoded → re-interpolated / dropped; towns away → recovery's point / the police point; `name_only` police point kept; NJDOT kept over a retired-SRI re-location) with a stub `Snapper`; and the Hudson fixture end to end (19 `intersection` recoveries, at exactly the road pages' points).

[wsa]: https://crashes.hudcostreets.org/road/hudson/jersey-city/west-side-avenue
[`road-anomalies.md`]: road-anomalies.md
