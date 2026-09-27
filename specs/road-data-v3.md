# Road data v3: NJDOT Roadway Network lines + NG9-1-1 names

**Superseded in part by [`road-data-v4.md`]:** `road-names` → `road-search`, entity ids renumbered in slug order, the entity merge fix, and the crash-alias rule.

**Status:** implemented on branch `road-data-v3` and tested on Hudson County subsets. Ready for a Batch build (see [Build](#build)). The full statewide build has not run yet.

Builds on the research in [`road-data-sources.md`] and serves Layer 1 / 4b of [`road-name-normalization-and-search.md`]:

- **Span-scoped aliases.** A local name applies only to the stretch of a route where it's used. "Kennedy Blvd" / "JFK Blvd" / "Hudson Blvd" apply only to CR 501's Hudson span, and "Tonnelle Ave" only to US 1 in Jersey City / North Bergen.
- **Colloquial primary names.** An entity's `name` is the local street name ("J F Kennedy Boulevard", "Tonnelle Avenue"), and the route designation moves to `route` ("CR 501 / CR 690 / CR 693", "US 1 / US 9").
- **Searchable names** for the ⌘K omnibar: `road-names.parquet`.

## Sources

| | Stage | Command | Vintage at dev time |
|---|---|---|---|
| NJDOT Roadway Network ([FS][rn-fs]): one M-aware polyline per SRI piece, with a milepost on every vertex | `njdot/data/roadway_network.parquet.dvc` | `njdot roads fetch-network` | `dataLastEditDate` 2026-07-28 |
| NJOGIS Road Centerlines of NJ (NG9-1-1) ([FS][ng-fs], layer 0) + Road Name Alias table (layer 1) | `njdot/data/ng911.dvc` (dir: `centerlines.parquet`, `aliases.parquet`) | `njdot roads fetch-ng911` | `dataLastEditDate` 2026-09-23 |

- Both fetches page the ArcGIS REST `query` endpoint (`njdot/arcgis.py`, POST, `OBJECTID` order, retries). Rows are one per feature path, with `x`/`y` (and for NJDOT `m`) vertex lists in EPSG:4326.
- The NG911 GNIS county / muni codes are decoded through the layer's coded-value domains to `county_{l,r}`, `cc_{l,r}` (NJ county code = alphabetical index) and `muni_{l,r}`.
- **Vintage is recorded** in each parquet's key-value metadata: `src_url`, `src_dataLastEditDate`, `src_lastEditDate`, `src_schemaLastEditDate`, and `src_where` / `src_bbox` for subsets. `roads build` copies the network and NG911 `src_*` keys into `sri-geom`, `road-entities` and `road-names` (as `network_src_*`, `ng911_src_*`).
- **`fetch:` rather than `side_effect: true`.** In dvx, `side_effect: true` means "no output hash": `write_dvc_file` drops `outs`, so the fetched data would never be recorded or pushed, and `roads.dvc` couldn't pin it. The stages instead carry `fetch: {schedule: manual}`, like `njsp/data/refresh.dvc`. That keeps `outs` tracked and makes `batch/reproc-targets` exclude them (it skips `fetch:` stages), so a reproc pins them and never re-fetches. `CLAUDE.md`'s "mark upstream fetches `side_effect: true`" only fits fetches with no outputs.
- `roads.dvc` deps now `/njdot/data/roadway_network.parquet` and `/njdot/data/ng911` instead of `/njdot/data/nj_mp_tenths.parquet`. The new deps and the new `git_deps` (`/njdot/road_net.py`, `/njdot/road_sources.py`) were added without hashes, and the existing `git_deps` hashes are unchanged, so the stage shows stale and dvx records the real hashes when it runs.
- Attribution: NJOGIS asks for "NJ Office of Information Technology, Office of GIS (NJOGIS)" on derived products. Add it, together with "NJDOT Roadway Network", to the site's data-sources page (follow-up).

## Model (`njdot/road_net.py`)

1. **Lines → MP points** (`rn_features`, `rn_points`). Points are laid every 0.05 mi, matching the old file's spacing, plus feature ends. They use the MP convention crashes use: a secondary / express SRI (`PARENT_SRI` ≠ `SRI` with a non-degenerate parent range) is measured on its parent's MPs, linear in the local measure. In a statewide attribute check that reproduces the old file's per-SRI MP ranges for 99.9% of SRIs (104,951 / 105,057). Vertex M-values are used as-is where they are monotone and span the feature's measure range, which was true of all 3,526 features in the Hudson bbox pull; elsewhere measure falls back to distance-proportional.
2. **NG911 segments → SRI MP intervals** (`ng_segments`, `ng_intervals`).
   - A segment's `SRI` tag is accepted when its start, midpoint and end all lie within 20 m of that SRI's line.
   - Untagged or mis-tagged segments of at least 30 m *snap* to a line only when all three points are within 10 m of it.
   - Each accepted segment's endpoints are projected onto the line (M interpolation) to give `[mp_lo, mp_hi]`.
3. **Names on points** (`name_points`). Each point takes the name, county and muni of the named interval it sits most inside (±0.03 mi). Points no interval covers keep the NJDOT `SLD_NAME`, and `cc` comes from a covered neighbor or the SRI's county prefix.
4. **Blip smoothing** (`roads.smooth_names`). A block of 3 or fewer points whose `(name, cc)` differs from matching blocks on both sides takes theirs, smallest blocks first and repeated.
   - Example: NG911 calls 2-point stretches of CR 501 in North Bergen "Kennedy Boulevard" inside "J F Kennedy Boulevard".
   - The points' own NG911 `seg` / `muni` are kept, so those names stay searchable on their spans.
5. **Runs** (`roads.road_runs`): same SRI, name and county, with contiguous MPs. A run's crash interval `[mp_lo, mp_end)` now stops at most 0.1 mi past its last point (`RUN_TAIL_MP`), where it used to run to the next run's start. Crash MPs inside an MP gap, e.g. CR 501 MP 7–23.8 where the route is co-signed elsewhere, are no longer pinned on the street before the gap.
6. **Entities** (`road_entities`). Runs join when they are in the same county, touch, and one's *name* is the other's name or NG911 local (`L`) alias, compared by `merge_key`. Runs "touch" when:
   - they are consecutive on one SRI;
   - a secondary run overlaps its parent's run;
   - a run end lies within 60 m of any point of the other run; or
   - for the *same* name in the same muni, their ends are within 400 m. West Side Ave in Jersey City has a ~350 m break near Journal Square in both NJDOT and NG911.

   The alias rules are narrow on purpose:
   - Only aliases covering ≥ 50% of a run's points count. One junction segment of Duncan Ave carries the alias "Bergen Avenue".
   - Two runs sharing *only* an alias don't join. NG911 aliases the North Bergen junction stretch of JFK Blvd "J F Kennedy Boulevard East", which would otherwise fuse JFK Blvd with Boulevard East.

   `merge_key` = `name_key` (abbreviations, directions spelled out, no spaces) plus squeezed doubled letters ("Tonnele" = "Tonnelle"), "John F" → "J F", "Jr" dropped, "Saint" → "St", and diacritics stripped.

## Outputs (`www/public/njdot/roads/`) and schema changes

No columns were renamed or removed.

| File | Change |
|---|---|
| `sri-geom`, `sri-hit{,-5,-6}` | Same columns. Points now come from the NJDOT 2025 lines, not `nj_mp_tenths` (≈Dec 2023). `name` is the NG911 `PRIMENAME` ("West Side Avenue", was "W Side Ave"), else `SLD_NAME`. |
| `road-entities` | **Added `cc` (int8), `munis` (string, " · "-joined, most-covered first).** `route` now holds NG911 shield designations ("CR 501", "US 1 / US 9"), falling back to the SLD name only for route-class roads (`subt` ≤ 6). `aliases` now lists NG911 local aliases covering ≥ 10% of the entity first, then crash-reported ones. |
| `road-runs`, `crashes-by-entity`, `crashes-by-sri`, `sris` | Same columns. `mp_end` is capped per step 5. |
| **`road-names`** (new) | ⌘K index, one row per `(entity, name_norm)` of non-ramp entities: `name_display`, `name_norm` (`norm_name`: upper-case, abbreviated), `kind` (`primary` / `route` / `alias`), `entity`, `cc`, `munis`, `subt`, `n_crashes`, `lon`/`lat` (float32; the on-road point nearest the bbox center), and bbox. Sorted `name_norm`, zstd-19. |

About `road-names`:

- Entity-level names get the whole entity's extent. These are the primary name, route designations and crash-reported aliases.
- NG911 names found on points get the extent of *those points*. These are other primaries, `L` aliases, `H` route names like "County Route 501", and shields.
  - So "Journal Square" locates its stretch of JFK Blvd, not the whole road, and it still points at the JFK Blvd entity.
- Aliases are scoped because entities are county-scoped named chains. "KENNEDY BLVD" / "JFK BLVD" / "HUDSON BLVD" rows exist only for the Hudson CR 501 entity, while "CR 501" rows exist for every CR 501 stretch statewide.

`www/src/map/roads/roadsData.ts` gets the new `RoadEntity` fields, a `RoadName` type and the `"road-names"` file. There is no UI change yet: omnibar integration is a follow-up.

## Hudson dev results

Hudson-bbox pulls: 3,526 NJDOT features, 11,438 NG911 segments and 3,653 alias rows. The crashes are the 973k statewide crashes on those SRIs, 268k of them in Hudson (`cc=9`). Reproduce with `njdot roads build -c <crashes-by-sri subset> -n <network> -g <ng911 dir> -o <out>` and `njdot roads audit … -O <overpass.json>`.

- **Tag check:** 10,207 segments carry an SRI present in the network, and 9,864 of those (96.6%) pass. 264 more snap, giving 10,128 intervals.
- **Naming coverage** (share of MP points named from NG911):
  - 99.3% on Hudson county and local SRIs (`09…`).
  - In the Jersey City / Hoboken / Bayonne core: 95.7% on interstates, 99.8–100% on US / state / 5xx routes, 98.9–99% on the rest.
  - The misses are mostly I-78 / Turnpike secondary carriageways.
- **Entities:** 4,075 with the old `nj_mp_tenths` build on the same SRIs, 2,952 now. The drop comes from alias- and gap-joined same-name runs and from `(name, cc)` blip smoothing. Hudson crashes on an entity: 227,985 / 268,332 (85.0%), the same as the old build's 227,956.
  - Of the rest, 38k have no MP and 2k have an MP outside their SRI's range.
- **Crash `road` strings**, among Hudson crashes with a local-name string (92,237). That excludes blanks, bare route numbers like "ROUTE 501" and "I-95 N J TPKE", and intersections like "A ST / B ST").

  | Name source | Share of those strings it covers |
  |---|---:|
  | NG911 primary names + aliases | 98.3% |
  | NG911 primary names only | 97.0% |
  | NJDOT SLD names | 93.5% |
  | OSM, all name tags (compare-only) | 95.7% |
  | NG911 ∪ OSM | 98.4% |
  | NG911 ∪ SLD | 98.9% |
  | string is one of its *own entity's* searchable names | 99.6% (86,744 / 87,074) |

  The top unmatched strings are crash-side spellings rather than NG911 gaps:
  - "JOSEPH A LEFANTE MEMORIAL HWY" (NG911: "Lefante Way")
  - "AVE E E"
  - "BLAKESLEE RT"
  - "43TH ST"
  - "CR 677II"
- **`road-names` size:** 3,251 rows (ramps excluded), 127 KB ≈ 39 B/row in Hudson. Statewide, NG911 has 113k distinct (name, muni) pairs, and Hudson's entity count tracks its own (name, muni) count, so expect ~120–150k rows ≈ **5–6 MB**. That is above "a few MB". If it's too big:
  - Store the bbox relative to `lon`/`lat` as int32 1e-5° offsets: −25% in the Hudson test.
  - Or index only entities with crashes.

## Decision for the user: OSM names (ODbL)

OSM is ODbL. Any published table containing OSM-derived names must be offered under ODbL (share-alike), with attribution. Nothing in this branch writes OSM data: `njdot roads audit -O` only *compares* against an Overpass dump kept in `tmp/`.

Hudson comparison (Overpass, `highway` ways in Hudson County, `out tags`):

- OSM has 6,999 named ways with 1,477 distinct name keys. 1,333 of them (90.3%) are already NG911 names or aliases.
- **144 names are OSM-only**, on 624 ways. They are mostly highway branding and facility names:
  - "New Jersey Turnpike Newark Bay Extension", "Essex Freeway", "New Jersey Turnpike Eastern/Western Spur", "Newark-Jersey City Turnpike", "NJ 139 Upper Level", "US 1-9 Truck"
  - plazas, bus lanes, and park and USPS driveways
  - By tag: `name` 120, `name_1` 16, `alt_name` 8, `old_name` 1.
- 1,309 of 1,733 NG911 primary names (75.5%) also appear in OSM.
- **Crash-string gain from OSM: +0.1 pp** (98.3% → 98.4%), almost all "CENTER AVE" (99 crashes).

Recommendation: **don't merge OSM.** The measured gain is ~0.1 pp of crash strings plus a handful of highway nicknames, and the cost is share-alike on `road-names` / `road-entities`. If the highway nicknames matter for search, add them by hand to a small curated alias file: the spec's `road_aliases.yml`, as facts, not OSM data. Your call.

## Build

This must run on Batch; there is no local pipeline run. Steps:

1. Bump `batch/infra/Pulumi.hccs.yaml` `ref` to this branch's pushed HEAD.
2. Run `pulumi up`. This needs your approval.
3. Submit:

```bash
AWS_PROFILE=h batch/submit -j roads-<ts> -b reproc-results/roads-<ts> \
  run -r r2 --no-commit --push each \
  njdot/data/roadway_network.parquet.dvc njdot/data/ng911.dvc www/public/njdot/roads.dvc
```

Notes:

- `mem_gb: 16` should suffice. The NG911 statewide pull is ~489k segments with vertex lists, about 245 pages of 2,000.
- On first run the fetch stages have no `md5`, so they run; afterwards `schedule: manual` keeps them from re-firing. To refresh NJDOT annually (August HPMS cycle) or NG911 monthly/quarterly, run the stage explicitly with `--force`.
- After the build: `njdot roads sync`, the usual path.

## Tests (`tests/test_roads.py`)

- Synthetic units cover:
  - shields
  - `name_key` / `merge_key`
  - `alias_candidates` (including the new route-ish suffixes)
  - parent-MP points
  - M-value fallback
  - tag check / snap / cross-street rejection
  - point naming
  - blip smoothing (names and county)
  - runs and the gap cap
  - the entity alias rules
  - crash assignment
  - point aliases
  - the entity table
  - span-scoped index rows
  - S2 order
  - `sris`
- Real-data fixtures live in `tests/data/roads/` (~540 KB: 22 SRIs' NJDOT lines statewide + their NG911 segments / aliases; fetch commands in the test module). They cover:
  - **CR 501**: the Hudson span `00000501__` [23.81, 37.31) is "J F Kennedy Boulevard". The Middlesex and Bergen stretches are other streets. "KENNEDY BLVD" / "JFK BLVD" / "HUDSON BLVD" rows point only at the Hudson entity, and "CR 501" points at every stretch.
  - **US 1**: "Tonnelle Avenue" (with NG911's "Tonnele" variant) is `00000001__` [54.7, 60.65), between Pulaski Skyway and Broad Ave (Bergen).
  - **West Side Ave**: Jersey City (4 SRIs, across the Journal Square gap) and North Bergen are two entities.
  - **West Side Ave → Duncan Ave at MP 1.95** on `09061684__`.
  - **Boulevard East ≠ JFK Blvd**: `09111121__` past MP 0.1, `00000505__` and `09000693__` form one entity.

## Correction: `09111121__` *is* JFK Blvd East (mostly)

The research report said [`road-name-normalization-and-search.md`]'s negative test was wrong because `09111121__` is Park Ave. It is SLD-named `PARK AVE`, but past MP 0.1 its NJDOT line runs along Boulevard East in Weehawken, and NG911 names those segments "Boulevard East" (aliases "J F Kennedy Boulevard East", "Jfk Boulevard East"). Only MP 0–0.1 is Park Ave.

JFK Blvd East / Boulevard East is:

- `09111121__` MP 0.1–0.92
- `00000505__` MP 0.7–1.9
- `09000693__` MP 0–2.3

`090006772_`, which the report listed, is Park Avenue. Both specs are updated.

## Follow-ups

- ⌘K omnibar: load `road-names` and match on `name_norm`, showing `munis` to disambiguate same-named streets. The span point / bbox flies the map to the matched stretch.
- Other `nj_mp_tenths` consumers could switch to the new MP points: `njdot/cli/backfill_geocodes.py`, `njdot cells --mp-path`, `njdot/sld.py`. Then retire `nj_crashes/sri/bulk_dl.py`.
- Credit NJOGIS and NJDOT on the data-sources page.
- Pre-2019 retired Hudson 6xx SRIs (~70k crashes statewide) still resolve to no line; this needs an old network vintage or crash lat/lon ([`road-data-sources.md`] §6).

[`road-data-sources.md`]: road-data-sources.md
[`road-data-v4.md`]: road-data-v4.md
[`road-name-normalization-and-search.md`]: road-name-normalization-and-search.md
[rn-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/NJDOT_Roadway_Network/FeatureServer/0
[ng-fs]: https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer
