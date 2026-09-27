# Road data v4: road pages, slugs, rankings, word search

**Status:** implemented on branch `roads-v4` and tested on fixtures. Sizes and bytes per lookup below were measured by re-emitting the new files from the v3 statewide build (Batch `roads-20260927-042820`), approximating two inputs that only exist at build time (see [Measurement](#measurement)). A Batch build is needed before the frontend can use them: `www/public/njdot/roads.dvc` is stale on purpose (new git deps `/njdot/road_outputs.py`, `/njdot/cc2mc2mn.py` and dep `/www/public/njdot/cc2mc2mn.json`, added without hashes).

**Layout tuning** (branch `roads-tune`, after the first v4 build `roads-20260927-100912`): footers carry no `pandas` / `ARROW:schema` metadata, and `sri-geom` is sorted by entity with 4k-row groups, `road-runs` 2k. See [Footers and layout tuning](#footers-and-layout-tuning). Needs another Batch build, plus the [frontend change](#frontend-notes) to `fetchEntityGeom`.

Builds on [`road-data-v3.md`]. Code: `njdot/road_outputs.py` (new), `njdot/cli/roads.py` (`road_outputs`, `write_outputs`), `njdot/road_net.py` (entity merge fix).

## What changed

| File | Change |
|---|---|
| `road-entities` | **New `slug`, `mc`, `length_mi`.** Entity ids renumbered in slug order, so sorted by `entity` = sorted by `slug`. Row groups 25k → 1k rows. |
| `crashes-by-entity` | Sorted `(entity, sri, mp, dt, id)` as before, but entity order is now slug order. Row groups 25k → 10k rows. |
| `crashes-by-sri` | **New `entity` (int32, null when on no entity).** Use it for crash → road lookups (see [Frontend notes](#frontend-notes)). |
| **`road-summary`** (new) | Crash counts per `(entity, year, severity)`. |
| **`road-summary-monthly`** (new) | Crash counts per `(entity, year, month, severity)`. |
| **`road-ranks`** (new) | Each county's and muni's top roads by crashes, fatal crashes, killed, crashes per mile. |
| **`road-search`** (new) | ⌘K word index; replaces `road-names`. |
| `road-names` | **Removed.** `roads build` deletes it from the output dir (so `roads sync --delete` drops it from S3). |
| `sri-geom`, `sri-hit*`, `road-runs` | Same columns. `entity` values are the renumbered ids. `alias` uses the dominance rule below. |
| `sri-geom` | **Sorted `(entity, sri, mp)`** (was `(sri, mp)`), row groups 25k → 4k, stats on `entity` only. Look points up by road. |
| `road-runs` | Row groups 25k → 2k, stats on `entity` only. |
| All files | **No `pandas` / `ARROW:schema` key-value metadata** in footers; only our own keys (source vintages, `road-search`'s synonym table etc.). |

Entities themselves change a little too: the [entity merge fix](#entity-merge-fix-park-ave--boulevard-east).

## Files

All zstd. "Stats" = the only columns with min/max statistics: fewer stats keep footers small when there are many row groups. Other columns have none, so don't expect pruning on them. "Dict" = the only dictionary-encoded columns; the default is all.

### `road-entities.parquet`

One row per entity. **Sort:** `entity`, which is also `slug` order. **Row groups:** 1,000 rows. **Stats:** `entity`, `slug`, `cc`, `mc`. **Dict:** none.

| Column | Type | |
|---|---|---|
| `entity` | int32 | 0-based rank of `slug` |
| `slug` | string | see [Slugs](#slugs) |
| `name` | string | local (NG911) name |
| `route` | string? | route designations, " / "-joined |
| `subt` | int8 | road class (1 interstate … 7 local, 8 ramp) |
| `sris` | string | comma-joined |
| `lon_min`, `lat_min`, `lon_max`, `lat_max` | double | bbox |
| `n_crashes`, `n_fatal`, `n_injury`, `n_killed` | int32 | whole-road totals (all assigned crashes, placed or not) |
| `aliases` | string? | " · "-joined: NG911 local aliases, then crash-report aliases |
| `cc` | int8? | county |
| `mc` | int16? | **new:** NJDOT muni code (`cc2mc2mn`) when the road is within one muni (slug has a muni segment), else null |
| `munis` | string? | NG911 muni names, " · "-joined, most points first |
| `length_mi` | float32 | **new:** road miles (see [Lengths](#lengths)) |

Lookups:
- `WHERE slug = '…'` and `WHERE entity = N` each hit 1 row group.
- A county's roads: `WHERE slug >= 'hudson/' AND slug < 'hudson0'` (`'0'` sorts right after `'/'`).
- A muni's single-muni roads: `slug >= 'hudson/jersey-city/' AND slug < 'hudson/jersey-city0'`.
- Both are one contiguous range: 2 row groups for Hudson.

### `crashes-by-entity.parquet`

Columns: `entity, sri, mp, id, year, dt, cc, mc, case, severity, tk, ti, pk, pi, tv, road, cross_street, route, loc_source, lat, lon`. **Sort:** `(entity, unplaced, sri, mp, dt, id)`, where `unplaced` = `loc_source` ∈ {`sri_only`, `name_only`}: crashes on the road without a map point come last within it. **Row groups:** 10,000 rows. **Stats:** `entity` only (so no `sri` pruning: filter on `entity`). **Dict:** `sri, severity, road, cross_street, route, loc_source` (−16% file size vs all-dictionary).

`loc_source` (string, added with crash location recovery; [crash-location-recovery.md § Shipped](crash-location-recovery.md#shipped-njdot-roads-build)) says how the crash got onto the road: `sri_mp` (NJDOT's coded SRI / MP, as before), `intersection` / `route_xs` / `latlon_snap` (recovered SRI / MP and point), `sri_only` (SRI, no MP / point) or `name_only` (no SRI / MP / point). The last two have null `mp`, `lat`, `lon`. The frontend reads it through a `COLUMNS('^(…)$')` select, so files from before recovery (no `loc_source`) still load.

### `sri-geom.parquet`

Columns `sri, mp, sld_name, name, subt, entity, alias, lon, lat`: one row per MP point (every 0.05 mi). **Sort:** `(entity, sri, mp)`. **Row groups:** 4,000 rows. **Stats:** `entity`. **Dict:** all.

- `WHERE entity = N` reads 1 row group (≤ 2: the largest entity has 1,526 points).
- **No `sri` stats**, and SRIs aren't contiguous. A lookup by SRI scans the whole file (20.6 MiB): use `sris.parquet` for per-SRI extents, or `sri-hit*` for a bbox.

### `road-runs.parquet`

`(entity, sri, mp_lo, mp_end)`. **Sort:** `(entity, sri, mp_lo)`. **Row groups:** 2,000 rows. **Stats:** `entity`. The frontend doesn't read it yet (`fetchEntityRuns` has no callers).

### `crashes-by-sri.parquet`

As before, plus `loc_source` / `how` (strings, after `route`) and `entity` (int32, nullable, last). Sort `(sri, mp, dt, id)`, row groups 25k, all stats.

- Recovered placed crashes (`intersection` / `route_xs` / `latlon_snap`) appear under their *recovered* SRI (a retired-SRI crash moves to the SRI it was re-located on). `name_only` crashes (no SRI) aren't in this file; `sri_only` ones are, with `entity` set.
- `how` (audit only): which rule resolved the road name (`exact` / `base` / `nodir` / `fuzzy` / `learned` / `route`), on crashes recovery tried; null on coded `sri_mp` crashes.
- `loc_source` = `none`: the crash has an SRI (without MP, or off every run) and recovery couldn't place it.

### `road-summary.parquet` / `road-summary-monthly.parquet`

| Column | Type |
|---|---|
| `entity` | int32 |
| `year` | int16 |
| `month` | int8 (monthly file only, 1–12) |
| `severity` | string (`f` / `i` / `p`) |
| `n` | int32: crashes |
| `tk` | int32: killed |
| `ti` | int32: injured |
| `n_unplaced` | int32: of `n`, crashes without a map point (`loc_source` `sri_only` / `name_only`) |

- `n` counts **every** crash assigned to the road, recovered ones included; `n_unplaced` drives the plots' faded / hatched segment and the "located by street name or route only" note.
- **Sort:** the key columns.
- **Row groups:** 10,000 (yearly) / 20,000 (monthly).
- **Stats:** `entity`.
- Only non-zero cells get a row: years or months without crashes are absent, so zero-fill on the frontend (as `yearStats` / `monthStats` do).
- Yearly = sum of monthly, so the frontend can read just the monthly file (~70 KB per road) if one fetch is preferred.

### `road-ranks.parquet`

One row per `(cc, mc, entity)` where the entity is in that area's top 50 (`RANK_TOP`) by *any* metric. **Sort:** `(cc, mc, rank_crashes, slug)`, nulls last. **Row groups:** 2,000 rows. **Stats:** `cc`, `mc`. **Dict:** none.

| Column | Type | |
|---|---|---|
| `cc` | int8 | county |
| `mc` | int16 | NJDOT muni code; **0 = the whole county** |
| `entity`, `slug`, `name`, `route`, `subt` | | the road (no ramps: `subt` < 8) |
| `n_crashes`, `n_fatal`, `n_killed` | int32 | the road's crashes / fatal crashes / killed **in this area**, by the crash's own `(cc, mc)`, recovered crashes included |
| `length_mi` | float32 | the road's miles in this area (0 if unknown) |
| `per_mi` | float32? | `n_crashes / length_mi`: **all years (2001–), not per year**. Null unless `length_mi` ≥ 0.25 and `n_crashes` ≥ 10 in the area |
| `rank_crashes`, `rank_fatal`, `rank_killed`, `rank_per_mi` | int16? | 1 = most; null outside the top 50 or when the value is 0 / null. Ties are broken by `slug` |

- A road crossing munis appears in each muni it has crashes in, with that muni's crashes and miles.
- Query: `SELECT * FROM … WHERE cc = 9 AND mc = 6 AND rank_killed IS NOT NULL ORDER BY rank_killed`.
- Divide `per_mi` by the number of data years for a per-year rate.

### `road-search.parquet`

One row per `(token, searchable name)`. **Sort:** `(token, n_crashes desc, entity, matched)`. **Row groups:** 2,000 rows. **Stats:** `token`. **Dict:** `token, kind, place, words`. Ramps (`subt` 8) aren't indexed (as in v3).

| Column | Type | |
|---|---|---|
| `token` | string | a canonical word of the name (see below) |
| `entity`, `slug`, `name` | | the road; `name` = its primary name |
| `matched` | string? | the name this row came from; **null when it's the road's own `name`** (so `alias` = `matched`) |
| `kind` | string | `primary` / `route` / `alias` |
| `words` | string | all canonical words of the matched name, space-joined, e.g. `west side avenue` |
| `subt` | int8 | |
| `n_crashes` | int32 | whole road |
| `cc` | int8? | |
| `place` | string? | `"Jersey City, Hudson"`, `"North Bergen Township · Jersey City, Hudson"`, `"Hudson County"` (3+ munis); munis alone when there's no county |
| `lon`, `lat` | float32 | on-road point of the matched name's span (a span-scoped alias locates its stretch) |
| `dx0`, `dy0`, `dx1`, `dy1` | int32 | bbox as offsets from `lon`/`lat`, in 1e-5° units (`lon_min = lon + dx0 * 1e-5`, …) |

- **Tokens:**
  - Take the name's words: NFKD → ASCII, lower-case, split on `[^a-z0-9]+`. That's the same as `queryTokens` in `roadSearch.ts`.
  - Map each word to its canonical long form through `SYNONYMS`: `w` → `west`, `ave` / `av` → `avenue`, `rt` / `rte` → `route`, ….
  - `st` is `saint` when it's the first of several words, else `street`.
  - A name contributes each distinct token once.
- **Cap:** each token keeps its 1,000 rows with the most crashes (`TOKEN_CAP`). 21 tokens are capped statewide: street types, directions, `county`, `route`, `cr`, `hill`, `trail`, `way`. Their full counts are in the key-value metadata.
- **Key-value metadata:**
  - `synonyms`: JSON `{canonical: [abbreviations]}`
  - `token_cap`
  - `capped_tokens`: JSON `{token: full count}`
  - `bbox_unit`
  - the source vintages
- **Query recipe:**
  1. Canonicalize the query words the same way.
  2. Pick one word to fetch: the longest word that isn't in `capped_tokens`. If it's the word being typed (the last word), fetch a prefix range `token >= 'kenn' AND token < 'keno'`; otherwise fetch the exact token `token = 'kennedy'`.
  3. Filter the returned rows client-side: every *other* query word must equal (or, for the last word, prefix) some word of `words`. For `st`, accept `street` or `saint`.
  4. Dedupe by `entity` and rank by `n_crashes`.

  This needs one ranged read per keystroke and no intersection query. Per-word intersection (`entity`, `matched`) also works.
- **Avoid 1-character prefixes:** `w` spans 6 row groups (~580 KB). From 2 characters on, a prefix is 1–2 row groups.
- **Synonyms live in one place:** `njdot/road_outputs.py` `SYNONYMS`. `www/src/map/roads/roadSearch.ts` `SYNONYMS` must list the same groups, or read the `synonyms` key-value metadata (DuckDB: `parquet_kv_metadata(url)`). The frontend table currently also has `["saint", "st"]`: `st` → {street, saint}, which is consistent.

## Slugs

`njdot/road_outputs.py` `entity_slugs`.

- **Form:** `<county>/<muni>/<road>` for a road within one muni, else `<county>/<road>`.
  - `hudson/jersey-city/west-side-avenue`
  - `hudson/j-f-kennedy-boulevard`
  - `hudson/north-bergen/west-side-avenue`
- **County and muni segments** use the site's `/map/<county>/<muni>` slugs: `normalize` in `www/src/county.ts`, i.e. lower-case with spaces → `-`, applied to the `cc2mc2mn` names. So `atlantic/egg-harbor-twp/…` and `cape-may/…`. Entities with no county (465, nearly all ramps) use `nj/…`.
- **Road segment:** `slugify(name)`: NFKD → ASCII, lower-case, apostrophes dropped, other runs of non-alphanumerics → `-`, trimmed (`st-pauls-avenue`). An empty result becomes `road`.
- **"Within one muni":**
  - Each point's NG911 muni name maps to an NJDOT `mc` (`muni_codes`).
  - A road is within one muni when exactly one muni covers ≥ 10% (`SLUG_MUNI_FRAC`) of the road's muni-coded points, and that muni is in the road's county.
  - A sliver across a boundary doesn't make a road multi-muni.
- **Muni-name mapping** (NG911 → `cc2mc2mn`):
  - Name forms are compared most specific first: "City of" / "Town of" prefixes are dropped, "Township" → "twp", "Borough" → "boro", and trailing type words are stripped one at a time. Among several matches, the muni whose own most specific form matches wins.
  - Examples: "Neptune City Borough" → Neptune City, "Neptune Township" → Neptune, "City Of Orange Township" → Orange, "South Orange Village Township" → South Orange.
  - One override: "Boonton" → Boonton Town.
  - 73 of 637 (cc, NG911 muni) pairs don't resolve. Nearly all are the next county's munis on boundary roads. Those points count as un-coded.
- **Collisions:**
  - Entities sharing a base slug are ordered by their first run's `(sri, mp_lo)`. That is a property of the road, not of entity numbering.
  - The first keeps the base; the rest get the lowest free `-2`, `-3`, …. A suffix that another road's base slug already uses (a road literally named "Main Street 2") is skipped.
- **Stable across rebuilds** as long as the road's name, county, muni coverage and first `(sri, mp_lo)` don't change. A *new* same-named road whose first run sorts earlier would take the base and shift the others' suffixes; that is the cost of short suffixes.
- **Unique:** yes, asserted by construction (`taken` set).

**Stats** (v3 entities + the approximate muni rule):

| | Count |
|---|---:|
| Entities | 100,817 |
| Muni-level slugs | ~95k |
| Needed a suffix | 1,412 (1.4%) |

Suffixes by class:

| Class | Suffixed |
|---|---:|
| Local (7) | 1,073 |
| Minor county / other (6) | 86 |
| Ramp (8) | 102 |
| State (3) | 59 |
| US (2) | 46 |
| County 5xx (5) | 42 |

Suffix values: `-2` 1,089, `-3` 167, `-4` 49, `-5`+ 36. Most non-local collisions are long highways split into several same-named county-level entities:

- `monmouth/state-highway-35-3`
- `hunterdon/state-highway-31-2`
- `ocean/state-highway-70-2`
- `essex/south-orange-avenue-2`
- `atlantic/atlantic-avenue-2`

Local ones are same-named streets in one muni that don't touch, e.g. `union/elizabeth/spring-street-2`.

**Entity ids = slug ranks (the `entity` → slug choice).** The alternative was a tiny `entity → slug` index file. Instead, `roads build` renumbers entities in slug order after computing slugs (`slug_order`), and every file's `entity` uses the new ids. Consequences:

- `road-entities` is sorted by both `entity` and `slug`, so either lookup is one read of one file, with no index file and no second round trip.
- County and muni prefixes are contiguous in every entity-sorted file (`crashes-by-entity`, `road-summary*`, `road-runs`), not just `road-entities`.
- Entity ids are **not** stable across builds (they weren't before either). URLs should use `slug`.
- `crashes-by-entity`'s `sri` order is no longer correlated with `entity`, and it has no `sri` stats. A crash → entity lookup by `sri` now belongs on `crashes-by-sri` (sorted by `sri`), which carries `entity`.

## Lengths

`entity_lengths`:

- Consecutive MP points on an SRI, at most 0.15 mi and 400 m apart (`RUN_GAP_MP` / `RUN_JUMP_M`), form a segment. The segment belongs to the first point's entity, county and muni.
- Segments are unioned per parent route: a secondary / express SRI is measured on its parent's MPs, so the two carriageways of a divided road count once.
- Outputs:
  - `length_mi` per entity (`road-entities`)
  - per `(entity, cc)` and `(entity, cc, mc)` (the `road-ranks` `length_mi`)
- Fixture checks:
  - JFK Blvd: 14.11 mi (CR 501 Hudson span 23.81 → 37.31, plus CR 690 / 693 pieces)
  - West Side Ave, Jersey City: 2.94 mi
  - Tonnelle Ave: 6.05 mi

## Entity merge fix (Park Ave ≠ Boulevard East)

**Symptom.** Boulevard East's aliases in v3 included "PARK AVE · WILLOW AVE", which looked like cross streets leaking in. They weren't cross streets.

**Cause.** The v3 "Boulevard East" entity *contained* Park Avenue (Hoboken `09101116__`, Weehawken `09111113__`, West New York `09121044__`, CR 677 `090006772_`…) and bits of Willow Ave. Crash reports on those SRIs say "PARK AVE" 100% of the time.

- The bridge was a 2-point "Park Avenue" junction run (`09111121__` MP 0–0.05), whose NG911 segment carries the local alias "Boulevard East".
- That alias covers 100% of the run, so the v3 rule (≥ 50% of the *run*) joined it to the next run on the SRI, which is Boulevard East.
- Every same-named Park Avenue run then followed transitively.

**Fix** (`road_entities`):

1. Same-name touching runs join first.
2. An alias join (one run's name is the other's major alias) then *also* needs the alias to cover ≥ 50% (`ALIAS_GROUP_FRAC`) of the aliasing run's whole same-name road (its phase-1 component).
3. The junction run's "Boulevard East" alias covers 2 of ~50 Park Avenue points, so there is no join.
4. JFK Blvd ↔ Kennedy Boulevard still joins: all fixture tests are unchanged, and there is a new fixture test `test_real_park_ave_is_not_boulevard_east`.

**Effect** (fixture subset with the real crashes on those SRIs):

| | v3 | v4 |
|---|---|---|
| Boulevard East | 6,016 crashes; aliases include "PARK AVE · WILLOW AVE" | 2,450 crashes; aliases "J F Kennedy Boulevard East · Jfk Boulevard East · Kennedy Boulevard East" |
| Park Avenue (Hoboken → Weehawken) | part of Boulevard East | its own entity, `hudson/park-avenue` |

Statewide effect unknown until the Batch build. Expect a few more, smaller entities wherever short junction runs carried a neighbor's name as an alias.

## Alias cleanup (crash-report aliases)

**Rule** (`stretch_aliases`, `entity_table`):

1. **Dominance.** A stretch (run × ½-mile MP bin) has a crash-report alias only if its top candidate string is ≥ 50% (`ALIAS_DOMINANT_FRAC`) of the stretch's candidate strings, and seen ≥ 3 times. A cross street reported as the `road` is a minority string on every stretch.
2. **Only where NG911 names nothing.** Entity-level crash aliases (`aliases`, and the search `alias` rows derived from them) come only from stretches whose points are mostly *not* NG911-named (`seg` < 0). Where NG911 names a stretch, crash strings add spelling variants and cross streets, not names.

   Summed per entity, an alias must still be ≥ 2% of the entity's crashes, must not equal the name, and must not duplicate an NG911 alias (by `merge_key`).
3. The per-point `alias` (`sri-geom` / `sri-hit*`, shown on hover) uses the dominance rule on all stretches, NG911-named or not.

**`ROUTE_RE`** also drops "CR 677II", "HUDSON COUNTY 677 2" and "HUDSON COUNTY 677 IV" style designations.

**Effect:**

| Road | v3 | v4 |
|---|---|---|
| Boulevard East | NG911 ×3 + "PARK AVE · WILLOW AVE" | NG911 ×3 only (via the merge fix; "JOHN F KENNEDY BLVD E" = NG911 alias by `merge_key`) |
| J F Kennedy Blvd | "Kennedy Boulevard · Hudson Boulevard · Jfk Boulevard" (all NG911) | unchanged ("KENNEDY BLVD" crash string = NG911 alias) |
| Tonnelle Ave (US 1) | none | none. NG911 now names it Tonnelle Avenue, so "TONNELLE AVE" is the name. Where crash aliases still help is the SLD-named secondary: "US 1 SECONDARY" (`00000001_S`, North Bergen) gets alias "TONNELLE AVE" |
| West Side Ave (JC, NB) | none | none |

Statewide estimate, from v3 outputs with "NG911-named" ≈ the point name is mixed-case:

- v3 had 3,259 crash aliases on 2,892 entities; v4 keeps ~100.
- The dropped ones are mostly cross streets on NG911-named roads: Grand Ave → "74TH ST", Garfield Ave → "BROADWAY", North 5th St → "DEVON ST".
- A few colloquialisms are lost: Park Plaza Dr → "PARK DR", 7th St → "SEVENTH ST".
- The kept ones are mostly SLD-named secondaries:
  - NJ 27 SECONDARY → "LINCOLN HWY"
  - NJ 21 SECONDARY → "MCCARTER HWY"
  - US 322 SECONDARY → "BLACK HORSE PIKE"
  - NJ 495 → "LINCOLN TUNNEL"

## Measurement

Numbers below come from the first v4 statewide build (Batch `roads-20260927-100912`), re-emitted by `tmp/tune.py` on branch `roads-tune` (dev only, not committed) with the tuned `write` settings. (The pre-build estimates, re-emitted from v3 outputs with approximate slugs and lengths, are superseded.)

Bytes per lookup:

- Computed from parquet metadata as footer + the column chunks of every row group whose stats overlap the filter.
- Cross-checked with native DuckDB 1.5.4 over httpfs against a local Range-capable server that logs bytes served, one fresh connection per lookup (default caches). DuckDB adds a 32 KB tail probe before the footer. With `parquet_metadata_cache` off it reads the footer twice (bind and scan); with it on, a second lookup on the same file reads only data.

| Lookup | v3 | v4 build (footer + data) | Tuned (footer + data) | Tuned, footer cached | DuckDB 1.5 first lookup, v4 → tuned |
|---|---:|---:|---:|---:|---:|
| `road-entities` one road (by `entity` or `slug`) | 1,452 KB | 193 KB (135 + 58) | **185 KB** (127 + 58) | 58 KB | 209 → 201 KB |
| `road-entities` county prefix `hudson/` | n/a | 307 KB (135 + 172) | 299 KB (127 + 172) | 172 KB | |
| `crashes-by-entity`, small road (22 crashes, `mercer/trenton/east-lafayette-street`) | 1,017 KB | 781 KB (570 + 211) | **774 KB** (563 + 211) | 211 KB | 912 → 905 KB |
| `crashes-by-entity`, West Side Ave JC (880) | 1,699 KB | 778 KB (570 + 208) | 771 KB (563 + 208) | 208 KB | |
| `crashes-by-entity`, JFK Blvd (27k, 4 groups) | 1,542 KB | 1,304 KB (570 + 734) | 1,297 KB (563 + 734) | 734 KB | 1,610 → 1,428 KB |
| `road-summary` one road | n/a | 42 KB (19 + 23) | **40 KB** (17 + 23) | 23 KB | |
| `road-summary-monthly` one road | n/a | 73 KB (40 + 33) | 70 KB (37 + 33) | 33 KB | |
| `road-ranks` one county (`cc = 9`, 2 groups) | n/a | 124 KB (20 + 105) | 118 KB (14 + 105) | 105 KB | |
| `road-search` `kenn*` / `main` / `tonnel*` (1 group each) | 5,056 KB | 184 / 180 / 188 KB (101 + data) | **176 / 172 / 180 KB** (93 + 83 / 79 / 87) | 83 / 79 / 87 KB | `kenn*` 200 → 192 KB |
| `sri-geom`, West Side Ave JC | | 1,122 KB (44 + 1,078: 2 of 40 groups) | **248 KB** (162 + 86: 1 of 245) | 86 KB | 1,155 → 280 KB |
| `sri-geom`, JFK Blvd | | **8,657 KB** (44 + 8,613: 16 of 40 groups) | **248 KB** (162 + 86: 1 of 245) | 86 KB | 1,158 → 280 KB |
| `road-runs` one road | | 263 KB (4 + 259) | **38 KB** (20 + 18) | 18 KB | 275 → 54 KB |

- `sri-geom` v4 = the frontend's current `fetchEntityGeom` query (`sri BETWEEN min AND max AND sri IN (…) AND entity = ?`), pruned on the `BETWEEN` only, since DuckDB-WASM's DuckDB (v0.9) doesn't prune on `IN` lists. JFK's SRIs run from `00000440__A101870` to `09000693__`, so the `BETWEEN` spans 16 of 40 row groups. Native DuckDB 1.5 does prune on the `IN` list (2 groups, 1.16 MB).
- Tuned `sri-geom` = `WHERE entity = ?`: every road reads one ~86 KB group, whatever its SRIs.

**Turn on DuckDB's parquet metadata cache in the frontend** (`SET parquet_metadata_cache = true`; older builds call it `enable_object_cache`), then verify in DevTools that repeat lookups skip the footer. With it, the "cached" column applies after the first lookup per file. Footers are most of a first lookup's bytes: a road page reads ~890 KB of footers (`road-entities` 127 + `road-summary-monthly` 37 + `crashes-by-entity` 563 + `sri-geom` 162) against ~390 KB of data for a small road.

## Footers and layout tuning

### Footer metadata

`write` (`njdot/cli/roads.py`) builds the Arrow table with `preserve_index=False`, drops the schema metadata, writes with `store_schema=False`, and adds our own key-value metadata through `ParquetWriter.add_key_value_metadata`. (`store_schema=False` on its own also drops `replace_schema_metadata` keys, which would lose `road-search`'s `capped_tokens` / `synonyms`.)

| File | Footer before | Footer after | Saved |
|---|---:|---:|---:|
| `crashes-by-sri` | 412,516 | 405,779 | 6,737 (1.6%) |
| `crashes-by-entity` | 569,813 | 563,076 | 6,737 (1.2%) |
| `sri-geom` (v4 layout) | 43,843 | 39,383 | 4,460 (10.2%) |
| `sri-hit` | 119,736 | 116,362 | 3,374 (2.8%) |
| `sri-hit-5` | 20,844 | 17,470 | 3,374 (16.2%) |
| `sri-hit-6` | 32,432 | 29,058 | 3,374 (10.4%) |
| `sris` | 11,343 | 6,824 | 4,519 (39.8%) |
| `road-entities` | 135,083 | 127,297 | 7,786 (5.8%) |
| `road-runs` (v4 layout) | 4,165 | 2,339 | 1,826 (43.8%) |
| `road-summary` | 19,407 | 16,993 | 2,414 (12.4%) |
| `road-summary-monthly` | 39,657 | 36,934 | 2,723 (6.9%) |
| `road-ranks` | 19,649 | 13,829 | 5,820 (29.6%) |
| `road-search` | 101,030 | 92,961 | 8,069 (8.0%) |

With the new layouts, `sri-geom`'s footer is 161,510 bytes (245 groups) and `road-runs`' 19,606 (63 groups).

- The `pandas` + `ARROW:schema` blobs were only 2–9 KB per file. `road-search`'s ~100 KB footer is 90 row groups of column-chunk metadata, not schema metadata, so stripping saves 8%.
- **Types are unchanged:** DuckDB `DESCRIBE` and every row are identical before and after, for every file (DuckDB never reads `ARROW:schema`). `dt` stays `TIMESTAMP_NS`, nullable ints keep their widths (`TINYINT` / `SMALLINT`), and `severity` etc. are `VARCHAR` as before.
- **Pandas readers** now get plain dtypes back: nullable ints as `float64`, strings as `object`. `roads build -c` reads `crashes-by-sri` through `read_crashes_by_sri`, which restores `crashes_by_sri`'s dtypes (`BY_SRI_DTYPES`, strings → `string`). `road_audit` only compares `cc` and reads strings, which works either way.

What the rest of a footer is (`crashes-by-entity`, 456 groups × 20 columns, ~62 bytes per column chunk):

| Part | Bytes |
|---|---:|
| `size_statistics` (Parquet 2.10 page-size histograms) | 95 KB |
| `encoding_stats` | 89 KB |
| `path_in_schema` | 51 KB |
| the rest: page offsets, sizes, `num_values`, `encodings`, codec, type, Thrift field headers | ~316 KB |
| min/max statistics (`entity` only) | 12 KB |

pyarrow 21 has no switch for `size_statistics` or `encoding_stats`. DuckDB's writer is worse here: 767 KB for the same file, since it writes min/max stats on every column. Remaining levers: fewer row groups or columns, or the metadata cache.

### Row-group sizes

Measured bytes (KB) per lookup, footer + data:

`sri-geom` (sorted by entity, stats on `entity`):

| Rows / group | Groups | Footer | Data (1 road) | First lookup | Cached |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 980 | 639 | 21–39 | 659–677 | 21–39 |
| 2,000 | 490 | 321 | 38–47 | 359–368 | 38–47 |
| **4,000** | 245 | 162 | 84–92 | **246–253** | 84–92 |
| 8,000 | 123 | 82 | 171–175 | 253–257 | 171–175 |
| 25,000 | 40 | 28 | 528–571 | 556–599 | 528–571 |

4k minimizes a first lookup and keeps a cached one under 100 KB.

`road-runs` (stats on `entity`):

| Rows / group | Groups | Footer | Data (1 road) | First lookup |
|---:|---:|---:|---:|---:|
| 500 | 249 | 76 | 5 | 81 |
| 1,000 | 125 | 39 | 9 | 48 |
| **2,000** | 63 | 20 | 18–19 | **38–39** |
| 5,000 | 25 | 8 | 47–49 | 55–57 |
| 25,000 | 5 | 2 | 258 | 260 |

`crashes-by-entity` (re-evaluated with the stripped footer; **stays at 10k**). The footer shrank only 1.2%, so the trade-off is unchanged:

| Rows / group | Groups | Footer | Small road (22) | West Side Ave (880) | JFK (27k) | US 1 Middlesex (52k) | Small road, cached |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 911 | 1,083 | 1,192 | 1,192 | 1,720 | 2,057 | 109 |
| 8,000 | 570 | 679 | 853 | 844 | 1,251 | 1,669 | 174 |
| **10,000** | 456 | 563 | **774** | **771** | **1,297** | **1,624** | 211 |
| 16,000 | 285 | 354 | 686 | 660 | 1,240 | 1,486 | 332 |

- 16k is ~60–140 KB cheaper on a first lookup but ~60% more per cached lookup.
- If the metadata cache proves to work in DuckDB-WASM, 5k is better for sessions viewing several roads: change `ROW_GROUP['crashes-by-entity']`.

**Sizes (MiB):**

| File | Size | Note |
|---|---:|---|
| `road-entities` | 5.6 | v3 5.3 |
| `crashes-by-entity` | 85.2 | v3 111.3: selective dictionaries |
| `road-summary` | 0.9 | 361k rows |
| `road-summary-monthly` | 2.2 | 1.38M rows |
| `road-ranks` | 0.7 | 26k rows |
| `road-search` | 7.2 | 181k rows after the cap; 311k before |
| `sri-geom` | 20.6 | 979k rows; 20.3 sorted by `sri` in 25k groups |
| `road-runs` | 1.1 | 124k rows |
| `road-names` | removed | v3 4.8 |

## Frontend notes

For wiring; the frontend is not changed on this branch.

- Road URL → `road-entities WHERE slug = ?`. Entity → `WHERE entity = ?`. The `mc` column says whether the slug has a muni segment.
- Road page plots, header and year strip → `road-summary` (or `-monthly`) `WHERE entity = ?`.
- Crash table → `crashes-by-entity WHERE entity = ?`. Drop the `sri IN (…)` filter: it no longer prunes, since there are no `sri` stats and entity order isn't SRI order.
- `fetchCrashEntity` (crash → road) → `crashes-by-sri WHERE sri = ? AND id = ?` (or the 4-field PK) and read `entity`. Querying `crashes-by-entity` by `sri` now scans the whole file.
- County / muni "most dangerous roads" → `road-ranks WHERE cc = ? AND mc = ?` (`mc = 0` for the county) `AND rank_<metric> IS NOT NULL ORDER BY rank_<metric>`.
- ⌘K → `road-search`, per the recipe above. The `RoadsFile` union loses `road-names` and gains `road-summary`, `road-summary-monthly`, `road-ranks`, `road-search`.
- **Road geometry → `sri-geom WHERE entity = ?`** (needed once `sri-geom` is sorted by entity; see below).
- `road-runs` → `WHERE entity = ?`: one ~18 KB group (2k-row groups).

### Frontend change for the entity-sorted `sri-geom`

`sri-geom` has no `sri` stats any more and isn't in SRI order, so an SRI filter scans the whole 20.6 MiB file. In `www/src/map/roads/roadsData.ts`:

- **`fetchEntityGeom(db, entity, sris)`**, called by `useRoadSelection.ts`, `routes/RoadPage.tsx` and `routes/CrashDetailPage.tsx` (with `road.data.sris.split(",")`). Change its query from

  ```sql
  SELECT sri, mp, sld_name, name, subt, entity, alias, lon, lat FROM read_parquet('…/sri-geom.parquet')
  WHERE sri BETWEEN '<min sri>' AND '<max sri>' AND sri IN (…) AND entity = <entity>
  ORDER BY sri, mp
  ```

  to

  ```sql
  SELECT sri, mp, sld_name, name, subt, entity, alias, lon, lat FROM read_parquet('…/sri-geom.parquet')
  WHERE entity = <entity>
  ORDER BY sri, mp
  ```

  Then the `sris` parameter is unused: drop it (and the three call sites' `sris` arguments, and the `enabled` / query-key dependency on the entity's `sris`, so the geometry fetch no longer waits for `road-entities`).
- **`fetchRoadGeom(db, sri)`** (`WHERE sri = ?`) has no callers. Delete it, or point it at the entity: it would scan the whole file.
- **Deploy order:** the old query still returns correct rows against the new file, just slowly: the `BETWEEN` no longer prunes, so every road reads all of `sri-geom`. The new query against the old file prunes nothing either (`entity` isn't correlated with `sri`), but is correct. Ship the frontend change with the data sync.
- Update the `roadsData.ts` header comment (`sri-geom` / `crashes-by-sri` by `sri` → `sri-geom` by `entity`).

## Tests

`tests/test_road_outputs.py` (new) covers:

- `slugify`
- muni-code mapping, with the real `cc2mc2mn`
- slugs: muni vs county level, sliver munis, collision order, taken suffixes, no county
- slug ranks
- lengths: secondary union, gaps, muni split
- yearly / monthly summaries
- ranks: area scoping, per-mile eligibility, ramps, top-N, ordering
- canonical words, place labels
- the search index: cap, `matched` nulling, bbox offsets, metadata
- `write`: footer key-value metadata is only ours (no `pandas` / `ARROW:schema`), stats only on the listed columns, and DuckDB types (`TINYINT` / `SMALLINT` nullable ints, `TIMESTAMP_NS`, `VARCHAR` categoricals) and values round-trip

`tests/test_roads.py` adds:

- the Park Ave / Boulevard East split (real fixtures)
- `stretch_aliases` dominance
- crash aliases only on un-named stretches
- the extra route designations
- an end-to-end `road_outputs` run on the real fixtures: renumbering / slug order, the Hudson slugs, `crashes-by-sri.entity`, summaries, lengths, `kennedy` search rows
- `write_outputs` on those outputs: the file set, each footer's key-value keys, `sri-geom` sorted `(entity, sri, mp)`, `entity`-only stats on `sri-geom` / `road-runs`, and `read_crashes_by_sri` restoring dtypes

## Build

As in [`road-data-v3.md`] § Build. Only `www/public/njdot/roads.dvc` needs to run; the fetch stages are unchanged:

```bash
AWS_PROFILE=h batch/submit -j roads-<ts> -b reproc-results/roads-<ts> \
  run -r r2 --no-commit --push each www/public/njdot/roads.dvc
```

Then run `njdot roads sync`. It deletes `road-names.parquet` from S3 and renumbers entities, so the S3 files and the www client (deployed separately) must switch together: ship the frontend change reading `road-search` / slugs right after the sync, or keep the old files until then.

[`road-data-v3.md`]: road-data-v3.md
