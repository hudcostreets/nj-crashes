# NJ road-network data sources, and an audit of `nj_mp_tenths`

Research for the road-level features in [`road-name-normalization-and-search.md`] (Layers 1–4b). Surveyed 2026-09-26; all dates below are as observed that day. No pipeline code was changed. Sample downloads and comparison scripts live in the uncommitted `tmp/road-data/` of the `road-data-research` worktree (`fetch.py`, `geom_cmp.py`, `ng_cmp.py`, plus `*.txt` outputs).

## TL;DR

- **Geometry + SRI/MP: NJDOT Roadway Network** (NJDOT's official LRS). It is a *line* layer with M-values (milepost) on every vertex, one feature per SRI (or SRI piece), 106,232 features, data last edited 2026-07-28. Our `nj_mp_tenths` points are a derived product of an earlier (≈Dec 2023) vintage of the same network, and they agree with it to under a meter.
- **Local / alias names: NJOGIS Road Centerlines (NG9-1-1)** plus its **alias table**. It is updated monthly (latest 2026-09-23) and has 489k street segments with a per-segment `PRIMENAME` and an **`SRI` column** (83% of segments; 98% of Hudson SRI tags agree with NJDOT geometry to within 5 m). The alias table is exactly the "Route 501 ≡ JFK Blvd" bridge the road-names spec wanted: `00000501__` is `J F Kennedy Boulevard`, with aliases `County Route 501`, `Hudson Boulevard`, `JFK Boulevard` and `Kennedy Boulevard`.
- **Audit:** our file is accurate but ≈2.5 years stale and coarser than the source. Of the SRIs in both files, 99.4% have matching MP ranges. Our points sit a median of 0.7 m from the current NJDOT line. SRI coverage differs by 37 SRIs that only we have and 432 that only NJDOT has (mostly new ramps). For crashes, 98.46% of SRI-tagged crashes' SRIs exist in both our file and the current network. The 1.5% gap is SRIs retired before 2019, and neither source covers it.
- **Recommendation:** refresh from the NJDOT Roadway Network lines instead of the SRI/MP points service, and derive MP points or polylines from the M-values. Take names and aliases from NG911 via its `SRI` column. Define a **road entity** as a set of `(SRI, mp_lo, mp_hi)` intervals whose NG911 segments share a normalized street name within a county. SRIs stay the crash-membership key; entities group them.

## 1. Where our current data came from

- `njdot/data/nj_mp_tenths.parquet` comes from `nj_crashes/sri/bulk_dl.py`. That script paginates NJDOT's ArcGIS Online **"New Jersey Standard Route Id. And Mile Post"** point FeatureServer ([item `e1fdf22f…`][sri-mp-item]; the `…/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0` URL in `bulk_dl.py`). The pull was done 2026-05-14 (commit `61027dbb973`).
  - Layer metadata: `dataLastEditDate` = **2023-12-08**, `lastEditDate` = 2024-04-30, 896,077 features. So the content is the late-2023 network.
  - The SRI set confirms this. Ours differs from the archived 2023 Roadway Network service by only 5/17 SRIs (ours-only/theirs-only), from the 2024 LRS service by 10/32, and from the current 2025 network by 37/432.
- The older per-SRI scraper (`nj_crashes/sri/cli.py` → `nj_sri_mp.db`, 2023-11) hit the same service one SRI at a time. `nj_crashes/sri/mp10.py` read the NJDOT **2021** "Milepost 10ths" shapefile (`TRAN_NJ_MP_TENTH_2021_shp`), which covers state highways only.
- **Correction: the points are at 0.05-mile spacing, not tenths.** 471,337 points have MP ending in `.x0` and 419,982 in `.x5`, plus about 2k SRI endpoints. US 1 has 1,298 points over 64.85 mi. The file name is misleading. The spacing is fine for hit-testing but coarse for MP→coordinate lookup, where interpolating along the line is better.
- **`Second_Name` is a per-point local street name, not an alternate name for the SRI.** It is non-null on 94,487 SRIs, mostly local roads, and appears to be copied from the NJOGIS centerlines. `09061684__` shows `W Side Ave` for MP 0–1.9 and then `Duncan Ave` for MP 1.95–2.45, so the file already encodes the "route turns onto another street" transition. It is null on state and 5xx county routes, which is why the road-names spec found no Kennedy alias for `00000501__`.

## 2. Candidate datasets

| Dataset | Publisher | Geometry | SRI | MP | Names | Vintage / cadence | Size |
|---|---|---|---|---|---|---|---|
| **NJ Roadway Network** ([FS][rn-fs], [item][rn-item]; bulk [`NJ_Roads.zip`][rn-zip] FGDB / [`NJ_Roads_shp.zip`][rn-shp]) | NJDOT BTD&S | polyline, **M-aware** (MP on vertices), EPSG:3424 | `SRI`, `PARENT_SRI` | `MP_START`, `MP_END`, `PARENT_MP_START/END` | `SLD_NAME` (official; 1 per feature) | FS data 2026-07-28 ("2025 SLD"); zips 2025-08-25; ≈annual (HPMS cycle) | 106,232 features / 105,489 SRIs; zips 37.7 MB (FGDB), 45.6 MB (shp) |
| NJ Roadway Network, 2023 edition ([FS][rn23-fs]) | NJDOT | same schema | ✓ | ✓ | ✓ | frozen 2023-10-31 | 105,838 features |
| `Tran_New_Jersey_Roads_LRS` ([FS][lrs-fs]) | NJDOT | same schema + `MIN_M/MAX_M` | ✓ | ✓ | ✓ | 2024-05-02 snapshot | 105,850 |
| **SRI and Milepost points** ([FS][sri-mp-fs]) (our source) | NJDOT | points, 0.05 mi | ✓ | `MP` | `SLD_NAME`, `Second_Name` | data 2023-12-08; stale | 896,077 points |
| Milepost 10ths ([`NJ_Milepost10ths_shp.zip`][mp10-zip]) | NJDOT | points, 0.1 mi, **state highways only** | ✓ | ✓ | — | 2025-08-25 | 1.5 MB |
| SLD-Web RNF ([`RNF_SLDWeb`][rnf-fs]) + [`SLD_Web_Milepost10th`][sldmp-fs] | NJDOT | segmented lines for the SLD viewer; 0.1-mi points | `sri` | ✓ | — | RNF dated 2024-08-23 | 150,592 lines; 471,524 points |
| Functional Class ([FS][fc-fs]) | NJDOT | lines | `sri` | ✓ | — | 2026-05-04 | 105,977 |
| **Road Centerlines of NJ (NG9-1-1)** ([hosted FS][ng-fs] layer 0; [MapServer][ng-ms]; bulk [FGDB][ng-gdb] / [SHP][ng-shp]) | NJ OIT Office of GIS (NJOGIS), with NJDOT, counties, and the 9-1-1 office | polyline, split at intersections and muni/zip lines, **no M** | `SRI` (83% of segments) | — (NJOGIS: "linear referencing will only be maintained by NJDOT") | NENA-parsed `ST_PREDIR…ST_POSTYP`, `PRIMENAME`, legacy `LST_*`, `SHLD_TYPE`/`SHLD_NUM` (route shield), address ranges, L/R county/muni/zip, `ROADCLASS`, `JURISDICTN` (S/C/M…), `ONEWAY`, `SPEEDLIMIT` | **monthly**; data 2026-09-23; zip 2026-09-18 | 489,277 segments; FGDB zip 132 MB |
| NG911 **Road Name Alias** table (same FS, layer 1) | NJOGIS | table keyed by `RCL_NGUID` | via segment | — | `AST_PNAME` alias, `ANAME_TYP` (H = highway/route, L = local), `ANAME_RANK` | monthly | 199,584 rows |
| OpenStreetMap | OSM contributors | ways | — (no SRI) | — | `name`, `ref`, `alt_name`, `old_name` | continuous | — |

Notes:

- Query limits: NJDOT hosted services allow 1,000–2,000 records per page (`maxRecordCount`); NJOGIS allows 2,000. All of them support `where`, `outSR=4326`, `resultOffset` pagination, and `returnM=true` (NJDOT lines). A statewide attribute-only pull of the Roadway Network took about 30 s. `fetch.py` uses POST, because long `IN (…)` clauses break GET.
- The NG911 bulk zips return 403 to a bare `curl` user agent and 200 to a browser user agent.
- NJDOT's [GIS data page][njdot-gis] is the canonical index for the bulk files. It also lists the 2024 HPMS-submission snapshot of the network (`HPMS_NJ_Roads.zip`, 2025-05-12).
- Divided roads: the secondary direction is its own SRI (`…_S`, `…_W`, `…ES` express, etc.). Its local measure runs *opposite* to the primary, and `PARENT_MP_*` maps it back onto the primary route. **Our file and crash records both use the parent MP for these SRIs.** For example, `00000444ES` spans MP 104.2–125.35 in ours and in crashes, while its local `MP_START/END` is 47.02–68.18 and its parent MP is 104–125. A refresh must emit parent-MP-space measures for non-primary SRIs.

### Licensing / terms

- **NJDOT** (Roadway Network, milepost products): the item metadata carries only a liability disclaimer ("…shall not be held liable for any errors… cannot be construed to be a legal document…"). There is no explicit license and no stated redistribution restriction.
- **NJOGIS** (NG911 centerlines + alias table): the metadata disclaims survey use and says "**Acknowledgement of the service provider, NJ Office of Information Technology, Office of GIS (NJOGIS), is requested** for maps, data or other products derived from this service". It is also subject to the State's [Conditions of Use][nj-legal], which impose no reuse or copyright restriction on State data. Credit NJOGIS (and NJDOT) on the site's about/data page.
- **OSM**: [ODbL][odbl]. This requires attribution, and a database *derived* from OSM that we publish (for example a `roads.parquet` embedding OSM names) must be offered under ODbL. That is manageable but viral. The NJ state sources avoid it, which is another reason to prefer NG911 for names.

## 3. Local names: which source?

| Source | Kennedy Blvd (`00000501__`, Hudson) | Tonnelle Ave (`00000001__`) | West Side Ave (Jersey City) | Joinable to SRI/MP? |
|---|---|---|---|---|
| NJDOT `SLD_NAME` | `ROUTE 501` | `US 1` | `WEST SIDE AVE` (whole of `09061684__`, including the Duncan Ave part) | native |
| Our `Second_Name` | null | null | `W Side Ave` → `Duncan Ave` (per point) | native (per MP point) |
| **NG911 `PRIMENAME` + alias** | `J F Kennedy Boulevard` (13.4 mi of 501's statewide length); aliases `County Route 501`, `Hudson Boulevard`, `JFK Boulevard`, `Kennedy Boulevard` | `Tonnelle Avenue` (plus a `Tonnele Avenue` spelling variant); aliases `US Highway 1`, `US Highway 9` | `West Side Avenue` on 4 JC SRIs (`09061684__`, `09061725__`, `09061575__`, `09061374__`); `Duncan Avenue` alias `County Route 605` | **yes**: `SRI` column; MP by projecting onto the NJDOT line (geometry coincides) |
| OSM | `John F. Kennedy Boulevard`, `ref=CR 501`, no `alt_name` (208 ways) | — | — | spatial only |

NG911 is the best local-name source. Its names are per segment, NENA-parsed (so no abbreviation guessing), and it has a curated alias table: 2,710 of 11,454 Hudson segments (24%) carry at least one alias, split between route-number aliases (`H`) and local ones (`L`). It is also monthly and SRI-tagged. OSM adds little here and brings ODbL.

NG911 SRI-tag quality, Hudson sample (`ng_cmp.py`): 8,534 segments carry an SRI that is present in the NJDOT sample. Measured from each segment's midpoint to the NJDOT line of the same SRI:

- median 0.0 m and p90 0.0 m, i.e. the same underlying geometry
- 98.3% within 5 m
- 115 segments beyond 20 m and 74 beyond 100 m

The outliers are genuine tag errors. For example, Gloucester County's Mullica Hill Rd / Main St segments carry `09061699__`, a Jersey City SRI, and sit about 150 km away. Statewide, 404,568 of 489,277 segments carry an SRI, covering 105,554 distinct SRIs, which is 101,795 of the 105,489 NJDOT SRIs (96.5%). Assign SRI/MP with an "SRI tag plus within X m of that SRI's line" check, and fall back to a spatial snap when the check fails.

The spec's negative test needs fixing. NJDOT and our file both name **`09111121__` as `PARK AVE`** (Weehawken). Its crash rows read `JOHN F KENNEDY BLVD E / PARK AVE`, i.e. intersection strings coded to Park Ave's SRI. In NG911, JFK Blvd East / Boulevard East is **`00000505__`** (CR 505), `090006772_`, and part of **`09000693__`**. `09000693__` is listed in the spec as part of the JFK corridor, but NG911 names it `J F Kennedy Boulevard` for 6 segments in North Bergen and `Boulevard East` for 34.

## 4. SRIs vs named streets: defining a road entity

The two keys are many-to-many, even within one county. In Hudson NG911:

- **by name:** of the 1,754 distinct `(PRIMENAME, muni)` pairs that carry an SRI, 1,291 map to exactly 1 SRI and 463 span 2 or more (one spans 18)
- **by SRI:** of the 1,724 Hudson-prefixed SRIs, 1,508 carry a single name and 216 carry 2–4 names

West Side Ave (JC) is 4 SRIs. `09061684__` is 44 segments named West Side Ave plus 12 named Duncan Ave. JFK Blvd spans `00000501__`, `00000501_S`, `09000690__` and `09000693__`. Separately, "West Side Avenue" in North Bergen (`09081095__`, `09081122__`) is a different street, so entity identity needs county or muni plus connectivity, not the name alone.

Proposed model, refining Layer 1 of the road-names spec:

1. **Base unit: SRI interval `(sri, mp_lo, mp_hi)`**, in the parent-MP convention that crashes use. This is what crash `sri`/`mp` resolve to, so crash membership is exact.
2. **Name each interval from NG911.** Project each NG911 segment with that SRI onto the NJDOT M-line to get `[mp_lo, mp_hi]`, and carry `PRIMENAME`, the aliases, `SHLD_TYPE`/`SHLD_NUM` and the L/R munis. Adjacent same-name segments merge into one interval.
3. **Road entity = connected chain of intervals sharing a normalized name within a county** (plus alias equivalence: a name and its `H` aliases are one entity). West Side Ave (JC) becomes `09061684__[0, 1.9] ∪ 09061725__[…] ∪ …`. Duncan Ave gets `09061684__[1.95, 2.45]`. JFK Blvd becomes `00000501__[Hudson range] ∪ 00000501_S[…] ∪ 09000690__ ∪ 09000693__[JFK-named part]`.
4. **Corridor overrides** (the spec's `road_aliases.yml` / `corridor_id`) remain the escape hatch, now for exceptions rather than the bulk of the work.
5. Non-SRI roads (about 11% of Hudson NG911 segments have no SRI, mostly private or alleys; `S1400` local roads carry SRIs at 87%) can be entities by name + connectivity, without MP.

## 5. Audit: `nj_mp_tenths` vs NJDOT Roadway Network (2025)

Sample: all Hudson SRIs (`SRI LIKE '09%'`: 1,753 SRIs, 12,250 points) plus US 1, NJ 440 and CR 501, both directions (6 SRIs, 3,715 points). Coverage, MP ranges and names were compared statewide, since that only needs attributes.

**SRI coverage (statewide):**

| | ours | NJDOT 2025 | overlap | ours-only | NJDOT-only |
|---|---:|---:|---:|---:|---:|
| SRIs | 105,094 | 105,489 | 105,057 | 37 | 432 |

- Ours-only: 21 retired ramps and 16 retired local streets (e.g. `SMITHVILLE BLVD`).
- NJDOT-only: 395 new ramps (`ROUTE_SUBTYPE` 8), 29 local streets, 4 × CR 5xx secondaries/bypasses, and 4 county-route secondaries (e.g. `HUDSON COUNTY 766 SECONDARY`).

**MP ranges (105,057 common SRIs):**

- 104,401 (99.4%) match NJDOT's min/max MP within 0.05 mi at both ends.
- 632 differ at the high end. 602 of those are the parent-MP convention on secondary/express SRIs (not real differences) and 4 are within 0.1 mi. That leaves **26 real extent changes** (re-measured locals and ramps, e.g. `12091253__` 0.5 → 1.68 mi).

**Names:** our `SLD_NAME` differs from NJDOT 2025 on 24 SRIs.

- typo fixes: `WHITTIET AVE`→`WHITTIER AVE`, `PATTERSON ST`→`PATERSON ST`, `ROBERTTS RD`→`ROBERTS RD`
- Trenton renames: `GEORGES RD`/`COMMERCIAL AV` → `PAUL ROBESON BLVD`
- Bayonne: `PORT JERSEY BLVD`→`CHOSIN FEW WAY` (`09011546__`)

**Geometry (`geom_cmp.py`)**, reprojected to NJ State Plane (m). `d_perp` is the distance from our point to the NJDOT line of the same SRI. `d_mp` is the distance to the point that NJDOT's M-values place at the same MP.

| group | points | `d_perp` p50 / p99 | `d_perp` >10 m | `d_mp` p50 / p99 | `d_mp` >10 m |
|---|---:|---:|---:|---:|---:|
| Hudson, primary SRIs | 12,035 | 0.7 / 0.9 m | 8 (4 SRIs) | 0.9 / 2.4 m | 58 |
| US 1 / NJ 440 / CR 501 primary | 2,191 | 0.7 / 0.9 m | 0 | 46.3 / 56.8 m | 1,299 (all US 1) |
| secondary / express / ramps | 1,739 | 0.7 / 0.9 m | 0 | (see note) | |

- **Shape is identical.** Our points lie on the current NJDOT lines. The ~0.7–0.9 m floor is a constant datum or projection offset.
- **Real changes are rare.** The 8 points more than 10 m off the line fall on 4 SRIs:
  - `09011257__` (Bayonne) was shortened from 0.35 to 0.17 mi, so our points past the new end are up to 307 m off.
  - `09061550__` (Jersey City) was realigned, by up to 183 m at MP 0–0.05.
  - 2 single points are off by 13 m and 22 m.
- Eleven Hudson primary points are more than 50 m off at the same MP, on 2 SRIs (`09061550__`, `09000655__`).
- **US 1 was re-measured.** Every US 1 point sits about 47 m (p50) away from NJDOT-2025's location for the same MP. MP 0 moved about 55 m and the route's length went from 64.85 to 64.91 mi. NJ 440 and CR 501 agree to 0.9 m.
  - Crash MPs are recorded against whatever LRS vintage was in force, so a roughly 50 m MP drift on long state routes is the scale of error to expect between vintages. That matters for segment studies near a cross-street, and not for corridor totals.
- Note on secondaries: a linear parent→local measure mapping isn't exact, because secondary lengths differ from the parent's, so `d_mp` there (p50 20–35 m) mostly measures my approximation. `d_perp` confirms the geometry. A refresh should use NJDOT's own parent-MP events rather than re-deriving them.

**Missing coordinates:** 230 points on 208 SRIs. All 208 SRIs exist in NJDOT 2025, but only 88 of the points fall inside a current NJDOT measure range. The rest sit in measure gaps (97 of them are the SRI's end MP). Refreshing from lines lets the 88 be interpolated. The others are points the current network doesn't have, and are harmless to drop.

**Vintage:** content is ≈Dec 2023 (service `dataLastEditDate` 2023-12-08). The SRI set matches the archived 2023 network best (5/17 differences, vs 37/432 against 2025). It was pulled 2026-05-14.

## 6. Crash-side coverage

`SELECT DISTINCT sri` (with counts) from `njdot/data/crashes.parquet`, 2001–2023. There are 46,677 distinct non-null SRIs across 4,565,030 SRI-tagged crashes.

| SRI source | SRIs matched | crashes matched | % crashes |
|---|---:|---:|---:|
| ours (`nj_mp_tenths`) | 42,445 | 4,494,652 | 98.46% |
| NJDOT RN 2025 | 42,443 | 4,494,623 | 98.46% |
| NJDOT RN 2023 | 42,446 | 4,494,653 | 98.46% |
| NG911 `SRI` tags | 41,568 | 4,466,468 | 97.84% |
| ours ∪ RN 2025 | 42,447 | 4,494,660 | 98.46% |

- By year, coverage is 93.7–94.0% in 2001–02, ~98–99% in 2003–18, and ≥99.7% from 2019 on (100.0% in 2020–22).
- The unmatched 4,230 SRIs (70,370 crashes) are **retired SRIs**: 63,414 of those crashes (90%) have no occurrence after 2018. The top ones are Hudson's old county-route SRIs (`09000617__` 3,305, `09000612__` 3,064, `09000605__` 2,040, …), `00000095M_` (4,645) and `00000509S_` (1,972). These look like the pre-2019 Hudson 6xx county-route SRIs, since NG911 now lists e.g. Duncan Ave as `County Route 605` on `09061684__`.
- NJDOT's `SRI_OLD` is *not* a lineage field; it is just the 8-character truncation. Recovering these crashes needs a pre-2019 network vintage, if NJDOT will provide one, or crash lat/lon.
- `aashto_supplemented_crashes.parquet` 2024+ (508,990 SRI-tagged crashes): ours matches 508,971 (99.996%), NJDOT 2025 matches 508,979.

Refreshing to 2025 changes crash coverage negligibly. Its value is in current names and geometry (new ramps, re-measures) and in line geometry for MP interpolation.

## 7. Recommendation

1. **Switch the geometry source to the NJDOT Roadway Network lines**: the [FS layer 0][rn-fs] (`returnM=true`, `outSR=4326`) or the annual [`NJ_Roads.zip`][rn-zip] FGDB.
   - Emit `roads_lines.parquet` (SRI, MP_START/END, parent MP, `SLD_NAME`, `ROUTE_SUBTYPE`, `DIRECTION`, geometry with M).
   - Derive the MP-point table from it, which replaces `bulk_dl.py`'s point scrape. Choose any spacing (0.05 matches today's consumers), use parent-MP measures for non-primary SRIs, and interpolate MP→lon/lat exactly for crash placement.
   - Keep `nj_mp_tenths.parquet` until the replacement ships. It is accurate enough (sub-meter shape, 99.4% MP-range agreement), so nothing is urgent.
2. **Add NG911 Road Centerlines + alias table as the name layer**: bulk FGDB monthly, or a filtered FS pull. Join on `SRI`, validate each segment against the NJDOT line (tolerance about 20 m, else spatial snap), and project segments to MP intervals. This replaces most of the spec's alias mining (Layer 1 sources 1–3); crash-text co-occurrence stays as a supplement for police spellings.
3. **Road entity = named chain of SRI-MP intervals within a county** (section 4), with `road_aliases.yml` for corridor-level overrides. Fix the spec's JFK Blvd East negative test to `00000505__` / `090006772_` / the Boulevard-East part of `09000693__`, not `09111121__`.
4. **Refresh cadence:** NJDOT annually (after the August HPMS-cycle release). NG911 quarterly or monthly (it's 132 MB; names change slowly). Record the source `dataLastEditDate` in the `.dvc` `meta` so vintage is never unknown again.
5. **Attribution:** credit "NJDOT Roadway Network" and "NJOGIS Road Centerlines of NJ (NG9-1-1)" on the site. Avoid OSM-derived names in published tables unless the ODbL share-alike is acceptable.

[`road-name-normalization-and-search.md`]: road-name-normalization-and-search.md
[sri-mp-item]: https://www.arcgis.com/home/item.html?id=e1fdf22f4ce04059b2f87dbaa1d727a2
[sri-mp-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0
[rn-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/NJDOT_Roadway_Network/FeatureServer/0
[rn-item]: https://www.arcgis.com/home/item.html?id=e64c45fa1ef14ef2b97b517c20f15878
[rn23-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_DOT_Roadway_Network/FeatureServer/0
[lrs-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/Tran_New_Jersey_Roads_LRS/FeatureServer/0
[rnf-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/RNF_SLDWeb/FeatureServer/11
[sldmp-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/SLD_Web_Milepost10th/FeatureServer/0
[fc-fs]: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/NJDOT_Roads_Functional_Class/FeatureServer/6
[rn-zip]: https://www.nj.gov/transportation/refdata/gis/zip/NJ_Roads.zip
[rn-shp]: https://www.nj.gov/transportation/refdata/gis/zip/NJ_Roads_shp.zip
[mp10-zip]: https://www.nj.gov/transportation/refdata/gis/zip/NJ_Milepost10ths_shp.zip
[njdot-gis]: https://www.nj.gov/transportation/refdata/gis/data.shtm
[ng-fs]: https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer
[ng-ms]: https://maps.nj.gov/arcgis/rest/services/Framework/Transportation/MapServer/14
[ng-gdb]: https://geoapps.nj.gov/njgin/road/Tran_road_NG911.gdb.zip
[ng-shp]: https://geoapps.nj.gov/njgin/road/Tran_road_NG911.shp.zip
[nj-legal]: https://www.nj.gov/nj/legal.shtml
[odbl]: https://opendatacommons.org/licenses/odbl/
