# Road anomalies: findings and fixes

**Status:** Round 1 (branch `road-anomalies`, §§ 1–11) is merged and built statewide (Batch `roads-20260927-160401`). **Round 2** (branch `road-anomalies-2`, [§ Round 2](#round-2)): verified on county dev builds (`njdot roads build -C <cc>`); **needs a statewide `roads.dvc` rebuild** to reach the site (see [Rebuild](#rebuild)).

Builds on [`road-model-v5.md`] (v5.1) and [`crash-location-recovery.md`]. Each section: symptom, root cause (with evidence), fix, before / after, and what's left. "Before" is the v5.1 code; "after" is this branch; both are county dev builds unless marked statewide. Statewide evidence queries ran against the statewide v5.1 outputs (`www/public/njdot/roads/`, Batch `roads-20260927-134754`) and `njdot/data/crashes.parquet` / `aashto_supplemented_crashes.parquet`.

## Contents

- [Summary](#summary)
- [1. West Side Ave (JC): 2019 → 2020+ drop](#1-west-side-ave-jc-2019--2020-drop)
- [2. NJ Turnpike express lanes, 2023+](#2-nj-turnpike-express-lanes-2023)
- [3. Newark Broadway: 2001–02, 2006–07](#3-newark-broadway-200102-200607)
- [4. Edgewater River Rd, 2010–12](#4-edgewater-river-rd-201012)
- [5. Kearny Ave: 2003–18](#5-kearny-ave-200318)
- [6. JC Bergen Ave, 2011–13](#6-jc-bergen-ave-201113)
- [7. Essex St vs West Essex St (Bergen)](#7-essex-st-vs-west-essex-st-bergen)
- [8. High unplaced shares](#8-high-unplaced-shares)
- [9. Muni coverage gaps (from the audit)](#9-muni-coverage-gaps-from-the-audit)
- [10. Port Authority crashes from 2019](#10-port-authority-crashes-from-2019)
- [11. Turnpike 2012–13](#11-turnpike-201213)
- [Round 2](#round-2)
  - [R2-1. Intersections: junctions, and offsets across a node](#r2-1-intersections-junctions-and-offsets-across-a-node)
  - [R2-2. Partial town-report gaps](#r2-2-partial-town-report-gaps)
  - [R2-3. Newark 2023–25](#r2-3-newark-202325)
  - [R2-4. 2001–02: county routes coded to state routes' SRIs](#r2-4-200102-county-routes-coded-to-state-routes-sris)
  - [R2-5. Rockaway Twp CR 513: a placeholder MP (2003–08)](#r2-5-rockaway-twp-cr-513-a-placeholder-mp-200308)
  - [R2-6. Somerville Circle stubs (pair swings)](#r2-6-somerville-circle-stubs-pair-swings)
  - [R2-7. Coded crashes on a road towns away (re-mileposted routes)](#r2-7-coded-crashes-on-a-road-towns-away-re-mileposted-routes)
  - [R2-8. Summit Ave: calibrating onto a road of several SRIs](#r2-8-summit-ave-calibrating-onto-a-road-of-several-sris)
  - [R2-9. More data notes](#r2-9-more-data-notes)
  - [R2-10. Audit: noted years](#r2-10-audit-noted-years)
  - [R2 code changes, dev-build totals, rebuild](#r2-code-changes-dev-build-totals-rebuild)
- [Data notes](#data-notes)
- [Code changes](#code-changes)
- [Audit changes](#audit-changes)
- [Dev-build totals](#dev-build-totals)
- [Rebuild](#rebuild)
- [Open items](#open-items)

## Summary

| # | Anomaly | Root cause | Fix |
|---|---|---|---|
| 1 | West Side Ave −30% from 2019 | Jersey City reports ~30% fewer property-damage crashes since 2020 (city-wide); West Side's share of JC crashes is steady | Data note `jersey-city-pdo-2020` |
| 2 | Turnpike express lanes spike 2023+ | AASHTO-format data (2023+) codes crashes to express-lane SRIs; corridor was already continuous, but missed the West Alignment's Kearny / Lyndhurst pieces and Fort Lee's I-95 | Code: freeway continuations join corridors; spine naming. Note `express-lanes-2023` |
| 3 | Newark Broadway 2001–02 / 2006–07 | 2001–02: coded to CR 649's SRI with no MP (448 crashes, off every road). 2006–07: most Newark North Ward reports missing from NJDOT's data | `recode` override `newark-broadway-cr649` (16 / 15 → 237 / 241); note `newark-2006-07-gap` |
| 4 | Edgewater River Rd 2010–12 | Edgewater PD's reports missing May 2010 – Dec 2012 (whole town: 136 / 3 / 3 crashes) | Note `edgewater-2010-12-gap` (and auto gap 2022) |
| 5 | Kearny Ave ~15/yr in 2003–18 | Coded `09000697__` (CR 697) at MPs 1.4–3.6, which today's network cut back (ends at MP 1.3): kept `sri_mp` on no road, never recovered | Code: off-run MPs of current SRIs are re-located / calibrated (2003–18: 2–68 → 64–121/yr) |
| 6 | JC Bergen Ave 2011–13 dip | Retired Hudson county-route SRIs | Already fixed by v5 calibration (2011–13: 179 / 144 / 169) |
| 7 | Essex St vs W Essex St swing | 2003–07: 80–126 crashes/yr coded to CR 56 at the NJ 17 interchange (one MP, 3.48); ~0–11/yr from 2008, not reappearing elsewhere | Unexplained; note `essex-st-rt17-2003-07` |
| 8 | Unplaced: Old Post Rd (Edison) etc. | Mostly no cross street, or a cross street met at two places (Old Post Rd meets US 1 at both ends). Found one fixable pattern: a road name NG9-1-1 aliases onto the cross street | Code: meet at the road's own segments (Middlesex +384 `intersection`) |
| 9 | (audit) Whole-town dips | 149 muni-year runs statewide where a police department's reports are (mostly) missing: ~58k crashes | Auto `coverage` notes (`muni_gaps`) |
| 10 | (audit) GWB / tunnels step in 2019 | Port Authority police crashes enter NJDOT's data in 2019 | Note `port-authority-2019` |
| 11 | (dev build) Turnpike 2012–13 dip | State Police Newark-station reports −34% | Unexplained; note `turnpike-2012-13` |

## 1. West Side Ave (JC): 2019 → 2020+ drop

**Symptom.** `hudson/jersey-city/west-side-avenue`: 172 crashes in 2019, 87 / 107 / 123 / 94 / 130 / 111 in 2020–25 (−30% on average), vs −14% statewide by 2022.

**Root cause: Jersey City's volume, not the road's coding.**

- West Side Ave's share of all Jersey City crashes is steady. Per 1,000 JC crashes: 20.1 (2019), 16.8 / 17.2 / 19.6 / 16.9 / 19.0 / 18.3 (2020–25); 15.7–24.5 in 2001–18. Crashes whose `road` names West Side ("W(EST)? ?SIDE"): 175 in 2019, 95–136 in 2020–25, 87–129 of them on the road each year, and 0–12 on any other road.
- 2019+ JC coding is stable: 89–97% of JC crashes are NJDOT-coded (`sri_mp`) every year from 2019; 96–98% are on a road. So nothing moved to cross streets or other roads.
- Jersey City's total fell 39% in 2020 (8,546 → 5,174) and stayed 20–35% down (6,058–6,848 in 2021–25), vs statewide 283k → 195k (2020), 243k–266k (2022–25). The drop is in property-damage crashes:

| Year | JC injury (i) | JC PDO (p) | Outside Hudson PDO |
|---|---:|---:|---:|
| 2019 | 1,532 | 7,006 | 205,834 |
| 2020 | 1,113 | 4,051 (−42%) | 141,203 |
| 2021 | 1,211 | 4,987 | 163,725 |
| 2022 | 1,232 | 5,053 | 176,383 |
| 2023 | 1,007 | 4,555 | 182,149 |
| 2024 | 1,535 | 5,304 (−24%) | 192,290 (−7%) |
| 2025 | 1,509 | 4,542 (−35%) | 190,532 (−7%) |

- The reporting agency didn't change: Jersey City PD filed 8,037 of 2019's 8,546 JC crashes and 4,771–5,756 in 2020–22.

**Fix.** Data note `jersey-city-pdo-2020` (kind `reporting`, 2020–25) on every Jersey City road that its police report (not interstates / toll roads / ramps).

**Residual.** Whether fewer minor crashes happen or fewer get reported (e.g. drivers exchanging information without a police report) isn't in the data. Injury crashes are back at 2019 levels by 2024, which points at reporting.

## 2. NJ Turnpike express lanes, 2023+

**Symptom.** The audit's top `yoy` findings (v5 statewide): every county's `…/new-jersey-turnpike-express` 0 → 100s in 2023–24, and `pair_swing`s between the main line and express entities (100% → 20–50% on the main line).

**Root cause.** NJDOT's 2023+ data (AASHTO format) codes crashes to the express-lane SRIs (`00000095E_`, `00000444E_` …) that the 2001–22 per-table data rarely or never used:

| Year | Turnpike express entities | GSP express | Other express (I-78, I-80, NJ 3, US 1 …) |
|---|---:|---:|---:|
| 2019–22 | 0 / 0 / 0 / 0 | 0 | 556–655 |
| 2023 | 732 | 111 | 893 |
| 2024 | 1,646 | 246 | 1,341 |
| 2025 | 1,694 | 319 | 1,320 |

The same crashes left the local lanes' entities; the Turnpike corridor (main line + express) is continuous: 7,031 (2019), 6,447 (2022), 5,973 / 6,500 / 6,432 (2023–25). The Hudson / Bergen pair swings in [`road-model-v5.md`] § Anomaly audit (NJ 495 vs its secondary, Holland Tunnel vs I-78, NJ 3 vs NJ 3 Express) are the same change on other divided highways.

**What wasn't continuous.** Corridor formation left some Turnpike pieces out: consecutive runs on one SRI pair only when both are named alike (or one isn't NG9-1-1-named), and NG9-1-1 names the West Alignment "New Jersey Turnpike West Alignment" in Kearny and "New Jersey Turnpike" in Lyndhurst. So `hudson/kearny/new-jersey-turnpike-west-alignment` (1,535 crashes; its own 2023–24 "spike" 15 → 95 / 237 is crashes leaving `hudson/new-jersey-turnpike`), `bergen/lyndhurst/new-jersey-turnpike`, Fort Lee's I-95 / I-95 Express / George Washington Bridge and the Pearl Harbor Memorial Bridge weren't in the corridor.

**Fix (code, `road_model.corridor_pairs`).** Consecutive runs on one SRI also pair when both entities are limited-access (`subt` 1 interstate / 4 toll road) and neither is named as a city street (`STREET_NAME_RE`: JC's "12th Street" carries I-78 but has cross streets and pedestrians). Statewide (from the v5.1 outputs) this adds 20 pairs:

- Turnpike: Kearny / Lyndhurst West Alignment, Fort Lee I-95 + Express + GWB, Pearl Harbor Memorial Bridge → the Turnpike corridor (24 → 30 entities).
- I-78: Newark and JC's "New Jersey Turnpike Extension" (Newark Bay–Hudson County Extension, I-78), Newark Bay Bridge, Holland Tunnel, Delaware River Bridge → one I-78 corridor (3 corridors → 1, 18 entities).
- GSP: Driscoll Bridge and Lakewood's piece join the two GSP corridors (3 → 1, 19 entities).
- Walt Whitman Bridge + I-76, Benjamin Franklin Bridge + I-676, Goethals Bridge + I-278, Scudder Falls Bridge + I-295.

The spine (which names the corridor) now prefers a member whose name isn't an auxiliary carriageway's (`AUX_NAME_RE`: Express, Secondary, Local, Alignment, Spur, Ramp, Truck): Middlesex's "New Jersey Turnpike Express" (27.55 mi) had beaten "New Jersey Turnpike" (27.50 mi), so the corridor was `nj/new-jersey-turnpike-express`, "New Jersey Turnpike Express". Statewide only this corridor had such a name.

**Before / after** (Bergen `-C 2`, the corridor containing `bergen/new-jersey-turnpike`): 7 → 13 members. Per year:

| Year | 2001 | 2012 | 2013 | 2018 | 2019 | 2020 | 2022 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 1,020 | 473 | 450 | 1,094 | 1,154 | 679 | 1,097 | 1,284 | 1,446 | 1,266 |
| after | 1,042 | 498 | 474 | 1,126 | 1,706 | 1,160 | 1,841 | 2,014 | 2,147 | 1,768 |

The 2019 step is the George Washington Bridge's Port Authority crashes ([§ 10](#10-port-authority-crashes-from-2019)); 2012–13 is [§ 11](#11-turnpike-201213). Statewide projection (v5.1 outputs, members summed): the Turnpike corridor gains 22–233 crashes/yr in 2001–18 and 494–829/yr in 2019–25 (7,031 → 7,589 in 2019).

**Note.** `express-lanes-2023` (kind `coding`, 2023–25) on every entity with a `00000xxxE` SRI, their corridors and the corridors' members.

**Residual.** Road pages for a single carriageway still show the 2023 break; the note says to compare the corridor.

## 3. Newark Broadway: 2001–02, 2006–07

**Symptom.** `essex/newark/broadway` (CR 667): 16 / 15 crashes in 2001–02, 163–196 in 2003–05, 24 / 13 in 2006–07, 119–203 in 2008–22. (The v4 audit called 2003–05 a spike; against 2008+ it's 2001–02 and 2006–07 that are off.)

**2001–02 root cause: coded to another route's SRI.** NJDOT coded Newark's Broadway crashes to `07000649__` ("CR 649") with no milepost: 221 in 2001, 227 in 2002, 0 after; and 0 Newark crashes were coded `07000667__` before 2003. Their cross streets are Broadway's: Third / Fourth / Seventh Ave, Delavan, Verona, Grafton, Chester, Elwood, Clay, Crittenden, Clark (the same as CR 667's in 2008–12). CR 649 today is JFK Parkway / South Livingston Ave (Livingston, West Orange); with no MP and two entities in Essex, recovery left all 448 off every road (`none`).

**Fix: `recode` override** (new rule kind, [Code changes](#code-changes)): `newark-broadway-cr649` rewrites `sri` `07000649__` → `07000667__` for Newark (7 / 14) 2001–02 before recovery. Recovery then places them by cross street (`route_xs`, 148) or on the route's one Essex entity (`sri_only`, 298).

**2006–07 root cause: missing reports.** Newark's total is 8,660 / 6,377 in 2006–07 vs 13,293 (2005) and 12,304 (2008); Newark PD's reports fell to 5,900 / 3,948 (from 9,859 / 10,127), evenly across months and severities. By latitude (placed crashes, 2006–07 vs the 2004–05 / 2008–09 average): ~10% of the usual crashes north of ~40.755° N (the North Ward: Broadway, Mt Prospect Ave, Summer Ave), 65–80% elsewhere. So the North Ward's reports are mostly absent from NJDOT's data. Not fixable; note `newark-2006-07-gap`.

**Before / after** (Essex `-C 7`):

| Year | 2001 | 2002 | 2003 | 2005 | 2006 | 2007 | 2008 | 2019 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 16 | 15 | 163 | 196 | 24 | 13 | 180 | 203 | 119 | 93 | 37 |
| after | 237 | 241 | 163 | 196 | 24 | 13 | 180 | 203 | 119 | 93 | 37 |

**Residual.** 2023–25 falls to 119 / 93 / 37 (AASHTO years); Newark's own total is 10,689 / 9,007 / 5,646. Newark's 2025 is 60% of expected, under the automatic gap threshold (50%); Broadway's is steeper. Not investigated.

## 4. Edgewater River Rd, 2010–12

**Symptom.** `bergen/edgewater/river-road`: 40 / 0 / 1 crashes in 2010–12 vs 95–236 around them; 36 in 2022.

**Root cause.** Edgewater's whole crash record: 136 crashes in 2010 (all but one in January–April), 3 in 2011, 3 in 2012, vs 351–406 in 2006–09 and 363–494 in 2013–15. Edgewater PD's reports aren't anywhere else in the data (by `pdn`, 0–2 a year in any other muni). So May 2010 – December 2012 is missing from NJDOT's data. 2022 is the same (Edgewater 51 vs ~308 expected).

**Fix.** Note `edgewater-2010-12-gap`; 2022 gets an automatic gap note ([§ 9](#9-muni-coverage-gaps-from-the-audit)).

## 5. Kearny Ave: 2003–18

**Symptom.** `hudson/kearny/kearny-avenue`: 133 / 126 crashes in 2001–02, 2–68 in 2003–18, 86–119 from 2019.

**Root cause: a cut-back SRI, and recovery never tried.** In 2003–18 NJDOT coded Kearny Ave as "HUDSON COUNTY 697", SRI `09000697__`, at MPs 1.41–3.59 (1,020 crashes, plus 276 without MP). Today's network has `09000697__` only from MP 0 to 1.3 (Frank E Rodgers Blvd in Harrison); Kearny Ave is `09071160__`. A crash whose SRI exists but whose MP is on no current run was kept `sri_mp` with no entity: `recover` treated "coded with an SRI in the network" as located, so it was neither re-located by name nor calibrated (calibration only handled SRIs gone from the network). In 2001–02 police strings named "KEARNY AVENUE" (placed by name); from 2018 NJDOT coded `09071160__`.

Statewide (v5.1) 27,368 crashes are coded to a current SRI at an MP no run holds, on 2,697 SRIs; 22,714 of them within 5 mi of the SRI's current MP extent. The big ones are cut-back / renumbered county routes: `13361373__` (Monmouth, 1,498), `09000697__` (1,021), `120006571_` (Middlesex CR 657 I, 952), `20000624__` (Union CR 624, 927), `12000689__` (899), `090006772_` (Hudson CR 677 II, 424, [below](#cr-677)) …; others are MP typos (`00000509__` MP 146.7 for 14.67).

**Fix (code, `loc_recovery.recover`).** A coded crash is "located" only when a current run holds its `(sri, mp)` (`entity_at`). Off-run crashes on a current SRI:

1. are re-located from their strings like uncoded crashes, but **without** their SRI's current lines (`route_xs` on them, or `sri_only` onto the SRI's current entity, would put the crash on the street the SRI *now* follows, which its MP says it isn't on);
2. failing that, are calibrated like retired SRIs (anchors: the SRI's other off-run crashes with points), only within `CAL_EXTEND_MI` (5 mi) of the SRI's current MP extent (a typo MP isn't a retired stretch);
3. else keep their SRI / MP, on no road (as before).

Calibration never snaps a route's crashes onto a ramp SRI (the first version put 33 East Orange "RT 509 (GROVE STREET)" crashes, MP 146.7, onto a GSP ramp).

<a id="cr-677"></a>Example of why (1) matters: pre-2018 `090006772_` (CR 677 II) ran past today's end (MP 1.22, Hoboken / Weehawken's Park Ave) into Weehawken at MPs 1.3–2.2, cross streets Baldwin Ave, North Marginal Rd, Highwood Terrace. With `sri_only` those went onto Park Avenue; without, they land on Boulevard East (`09111121__`), which the police-reported points at those MPs confirm (MP 1.6's 24 points: 2 m from Boulevard East).

**Before / after** (Hudson `-C 9`):

| Year | 2001 | 2002 | 2003 | 2005 | 2008 | 2012 | 2016 | 2017 | 2018 | 2019 | 2022 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Kearny Ave before | 133 | 126 | 16 | 12 | 10 | 19 | 68 | 2 | 25 | 114 | 115 |
| Kearny Ave after | 133 | 126 | 73 | 83 | 75 | 121 | 112 | 98 | 90 | 114 | 115 |
| Boulevard East before | 170 | 174 | 111 | 125 | 107 | 103 | 133 | 124 | 143 | 122 | 186 |
| Boulevard East after | 175 | 176 | 192 | 153 | 115 | 128 | 150 | 145 | 165 | 122 | 186 |

Middlesex: Edison's Parsonage Rd (CR 657 I) 2003–19 goes from 1–20 to 38–66/yr (2020+: 40–97); Old Bridge's Matawan Rd (CR 689) 0–6 → 9–44. Crashes on a road: Hudson +1.9k, Essex +0.7k, Bergen +0.8k, Middlesex +4.0k ([totals](#dev-build-totals)).

**Residual.** Kearny Ave's 2003–10 (64–88) are still below 2011+ (90–121); the calibrated share of 2003–10 is lower (fewer anchors early). 2001–02 (133 / 126) came from name strings and look high against 2003+; not investigated.

## 6. JC Bergen Ave, 2011–13

**Symptom (v4).** `hudson/jersey-city/bergen-avenue` 44 / 28 / 31 in 2011–13 vs ~110.

**Already fixed by v5's retired-SRI calibration**: 179 / 144 / 169 (v5.1 statewide), with 135 / 116 / 138 of them `sri_calib`. Unchanged here (±3).

## 7. Essex St vs West Essex St (Bergen)

**Symptom.** Pair swing `bergen/essex-street` vs `bergen/maywood/west-essex-street` (share on Essex St 100% in 2001 → 44% in 2007). West Essex St (0.3 mi, CR 56 MP 3.35–3.65) has 122–181 crashes/yr in 2003–07 and 17–50 after.

**Root cause.** In 2003–07 NJDOT coded 106 / 126 / 80 / 84 / 90 crashes to `020000561_` (CR 56) at exactly MP 3.48, the NJ 17 interchange, in Maywood and Rochelle Park, road "BERGEN COUNTY 56 I", cross street mostly "RT 17" / "NJ 17" / "… RAMP". From 2008 it's 0–11 a year at that MP. The crashes don't reappear elsewhere: NJ 17 crashes with a CR 56 / Essex cross street stay ~50/yr throughout, the two towns' other SRIs don't rise, and their combined total falls by about the excess (1,239/yr in 2003–07 → 1,129 in 2008–12). So it's a real change (the interchange?) or a reporting one; the data can't say. W Essex St is where MP 3.48 falls, so it absorbed all of it; the corridor (Essex St + W Essex St + Rochelle Park's Essex St) has the break too.

**Fix.** None to the data. Note `essex-st-rt17-2003-07` (kind `unexplained`).

## 8. High unplaced shares

| Road | Crashes | Without a point | Why |
|---|---:|---:|---|
| `hudson/bergenline-avenue` | 8,825 | 3,075 (35%) | (Hudson dev build) 2,622 of them have no cross street (1,712 `name_only`, 910 `sri_only`): nothing to intersect. |
| `hudson/north-bergen/west-side-avenue` | 1,221 | 691 (57%) | 480 have no cross street. The rest: "CR 681" (Paterson Plank Rd) and "PENHORN AVE" / "69TH ST": the road meets them at two points ~140 m apart (a triangle junction); the cluster's mean is > 30 m from West Side Ave's line, so the snap fails ([Open items](#open-items)). |
| `middlesex/edison/old-post-road` | 2,391 | 1,136 → 1,053 (44%) | "US 1" (~400): Old Post Rd meets US 1 at both ends, 1 km apart: genuinely ambiguous without a point. "VINEYARD RD" (~230): fixed in part, below. |

**Found and fixed: a road name aliased onto its cross street.** NG9-1-1 aliases 17 of Edison's 20 Vineyard Road segments "Old Post Road". An "OLD POST RD" × "VINEYARD RD" crash met its cross street all along those shared segments: 51 meets over 1 km, so no intersection. `_locate_strings` now drops the segments carrying both names and takes the road as the segments carrying its name as their own: one meet, where Old Post Rd ends at Vineyard Rd. The same fix moves crashes whose old meets did cluster but snapped to the shared segments' SRI, i.e. the cross street: "GRAND ST" × "JOHNSTON AVE" (29 crashes) goes from Johnston Ave to Grand St, "HAMILTON ST" × "EASTON AVE" (38) from Easton Ave to Hamilton St, "CATOR AVE" × "PRINCETON AVE" to Cator Ave, and so on: every sampled move is onto the road the police named. Middlesex: `intersection` +384, `name_only` −395; Hudson: `none` +47 (crashes the old meets had put on the cross street, e.g. "JOHN ST" × "WOODLAND AVE" in Kearny, 11). Old Post Rd: 1,136 → 1,053 without a point; 111 "OLD POST RD" × "VINEYARD RD" crashes stay name-only (a stated distance / direction the road doesn't run).

## 9. Muni coverage gaps (from the audit)

Running `audit-anomalies` on the statewide v5.1 build turned up many whole-town dips: Pleasantville's South Main St / West Delilah Rd / New Rd (2024 "spikes" after 2020–23 lows), Deptford's Hurffville Rd / Clements Bridge Rd (2013–14), Bridgeton's Broad St (2018–20, 2023), Boonton's Main St (2021–23), Gloucester Twp's Erial Rd (2015–16). In each, the **muni's whole crash total** collapses those years, and the police department's reports aren't under another muni:

| Muni | Years | Crashes (expected) |
|---|---|---|
| Union City | 2022 | 148 (1,234); Union City PD: 36 vs 978 in 2021 (raw `NewJersey2022Accidents.pqt`: 37) |
| Atlantic City | 2021 | 206 (1,473); AC PD 94 vs 1,878 in 2019 |
| Plainfield | 2020 | 2 (711); Plainfield PD 0 |
| Deptford | 2013–14 | 380 / 405 (1,315 / 1,483); the rest is State Police on Routes 42 / 55 |
| Bridgeton | 2018–20 | 8 / 3 / 1 (346 / 329 / 166) |
| Pleasantville | 2021–22 (also 2013–14) | 78 / 65 (199 / 254) |
| Boonton | 2021–23 | 62 / 100 / 42 (237 / 245 / 249) |
| Irvington | 2022–23 | 574 / 769 (2,464 / 1,970) |

**Fix: automatic coverage notes** (`road_notes.muni_gaps`). Per muni with a median ≥ 100 crashes/yr, a year is a gap when its total is < 50% of the median of up to 3 years either side, each scaled by the rest of its county's total that year (so 2020 isn't one). Statewide: **149 runs of gap years in 113 munis, ~58k crashes missing** (sum of expected − observed); 63 runs start in 2020 or later. Top by volume: Irvington 2022–23 (~3.1k), Gloucester Twp 2015–16 (2.7k), Perth Amboy 2021–22 (2.4k), Deptford 2013–14 (2.0k), Trenton 2017 (1.8k), New Brunswick 2010 (1.4k), Sayreville 2013, Atlantic City 2021, Pennsauken 2023, Union City 2022, Elmwood Park 2022–23, Camden 2021, Ramsey 2012–13, Plainfield 2022, Edgewater 2010–12. The build turns each into a `coverage` note (`gap-<cc>-<mc>-<years>`) on the roads through the muni that its police report (not interstates, toll roads, ramps), unless a curated note covers that muni and those years (Edgewater 2010–12, Newark 2006–07 — Newark's 2006–07 is 50–65% of expected, above the threshold, so it's curated).

`audit-anomalies` then drops the road `yoy` findings a note explains (Bergen dev build: 26 of 85).

**Residual.** The threshold misses partial gaps (Newark 2006–07 citywide; Newark 2025). A lower threshold would start to catch real changes; a per-department view (by `pdn`, which AASHTO 2023+ doesn't carry: its `pdn` is the muni) would be sharper.

## 10. Port Authority crashes from 2019

**Finding** (from the Turnpike corridor's 2019 step). Crashes reported by the Port Authority Police are all but absent from NJDOT's data before 2019 (at most 13 a year, 2001–18) and number 1,350 / 1,541 / 2,299 / 2,526 in 2019–22. They're the GWB and its approach (`bergen/fort-lee/george-washington-bridge`: 2 in 2018, 484 in 2019, 100% Port Authority in 2019–22), the Lincoln Tunnel / NJ 495 helix (69–100%), the Holland Tunnel (74%) and JC's 12th St approach (60%), Port Newark's Port St / Corbin St, and I-278 / the Goethals Bridge. Fort Lee's total rises 1,500 → 2,046 in 2019 for this reason. (AASHTO 2023+ doesn't name the agency, so the share after 2022 isn't measurable.)

**Fix.** Note `port-authority-2019` (kind `coverage`, 2001–18) on those roads.

## 11. Turnpike 2012–13

**Finding** (Bergen dev build's corridor series). New Jersey Turnpike crashes: 6,827 (2011), 5,310 (2012), 5,010 (2013), 5,925 (2014) statewide (−22%); in Bergen + Hudson 1,831 → 1,205 / 1,172 → 1,643 (−34%), nearly all State Police reports from the Newark station (1,669 → 1,123 / 1,103). State Police crash reports statewide fell 11% in 2012 and recovered in 2013; the GSP dipped 12% in 2012 only. No cause found.

**Fix.** Note `turnpike-2012-13` (kind `unexplained`) on the Turnpike corridor and its members.

## Round 2

Branch `road-anomalies-2` (from `map-mode-heatmap-on-cells` after round 1 merged and built statewide, Batch `roads-20260927-160401`). "Before" is that code; dev builds are `njdot roads build -C <cc>`; statewide audit numbers use the statewide outputs with this branch's notes recomputed (`tmp/sw_notes.py`: curated notes + `muni_gaps` on statewide muni-year-month counts; a road's munis are those with ≥ 3 of its crashes).

### R2-1. Intersections: junctions, and offsets across a node

**Symptom.** Crashes whose road meets the cross street at two points 100–150 m apart failed to place (North Bergen West Side Ave × Paterson Plank Rd, [§ 8](#8-high-unplaced-shares)); so did crashes where they meet at both ends of the road (Edison's Old Post Rd × US 1).

**Root causes** (`tmp/dbg_junction.py`, Hudson / Middlesex subsets):

1. **The cluster's mean can be off the road.** West Side Ave meets Paterson Plank Rd (CR 681) at two NG9-1-1 nodes 138 m apart where West Side Ave bends: one meet twice, the other four times (one per touching segment pair). The old rule took the mean of all meets if they were within 150 m of it (they were); the mean is > 30 m from West Side Ave's lines, so the snap failed. "PENHORN AVE" (two meets 358 m apart) was ambiguous outright.
2. **Several separate junctions** (a crescent, a road meeting the cross street at both ends): ambiguous, even when the stated direction rules one out.
3. **`offset_along` only moved along the single nearest segment.** At an NG9-1-1 node (where nearly every meet is) two road segments are equally near and the first one found often *ends* there, so a crash "200 ft N of" the cross street, with the road going on north along the other segment, got no point (`offset_along` → None) and fell back to name-only. This, not the junction shape, was the big one.

**Fix (`loc_recovery`).**

- `junctions` replaces `cluster_point`: the distinct meets are chained within 300 m into groups; a group whose meets are all within 150 m (`JUNCTION_M`) of its meet-weighted mean is one junction (carriageways of a divided road, a triangle, a slip lane). Its point is that mean if it's within `SNAP_M` (30 m) of the road, else the group's meet nearest the mean. A group spread wider is the road running *along* the cross street ("TONNELE AVE" × "US 1 / US 9", "BERGEN AVE" × "BERGEN AVE"): then no junction at all. (A first version projected the plain mean onto the road; it moved Weehawken's "PARK AVE" × "19TH ST" crashes onto Willow Ave, whose SRI the projection hit; the meet-weighted mean is what the old rule used, so crashes it placed stay put.)
- `_locate_one`: several junctions → the one from which the stated offset / direction leads along the road onto its NJDOT lines. If more than one does (no direction, "AT", or both ways possible), the intersection doesn't place the crash; it falls to the reported point or the road's name / SRI (no point), with `how` = "junctions" when nothing else places it (the build logs the count: Hudson 690, Essex 1,240, Middlesex 3,690).
- `offset_along` tries every road line within `TOUCH_M` of the nearest and takes the move that goes farthest in the stated direction.

**Precision** (blind re-location of NJDOT-coded crashes, `njdot roads recover -C <cc> -e 30000 -m <mode>`, entity agreement with NJDOT's own coding; `-E` now writes the per-crash results):

| Eval | `intersection` before | after | precision before → after | `name_only` before → after | assigned (any) precision |
|---|---:|---:|---|---:|---|
| Hudson `new` (2021+) | 12,170 | 13,675 | 97.7% → 97.8% | 2,386 → 914 | 97.7% → 97.7% |
| Hudson `old` (2006–16) | 3,126 | 4,002 | 98.1% → 98.4% | 1,342 → 472 | |
| Middlesex `new` | 4,682 | 5,214 | 98.5% → 98.5% | 2,389 → 1,885 | |

In Hudson `new`, 1,473 crashes go `name_only` → `intersection`: their road is still NJDOT's 98.4% of the time (as by name alone), now with a point a median 10 m from NJDOT's. `route_xs` gains 20–80 per eval at the same precision. Splitting the gain (Hudson full recovery, 261k crashes tried): `intersection` 78,254 → 93,156 with the `offset_along` fix alone, → 93,527 with junctions too (+ `route_xs` 8,953 → 9,209).

**Before / after** (dev builds, this change alone):

| Build | Crashes on a road | Without a point |
|---|---|---|
| Hudson `-C 9` | 406,339 → 406,955 | 66,301 → 51,702 |
| Essex `-C 7` | 610,713 → 611,001 | 70,583 → 63,071 |
| Middlesex `-C 12` | 599,880 → 601,105 | 47,206 → 33,438 |

| Road | Without a point, before → after |
|---|---|
| `hudson/north-bergen/west-side-avenue` (1,223) | 692 → 530 |
| `hudson/bergenline-avenue` (8,817) | 3,075 → 2,861 |
| `hudson/jersey-city/west-side-avenue` (3,788) | 355 → 256 |
| `middlesex/edison/old-post-road` (2,394) | 1,053 → 828 |

Per-road totals barely move (Hudson: 1,330 crashes change road, net +616; Middlesex 2,186 / +1,358, mostly off-run CR 602 crashes now placed by cross street or calibrated onto Inman Ave, +116). West Side Ave's remaining 530 are mostly without a cross street (473) or coded with no point (sri_mp, AASHTO 2023). Old Post Rd × US 1 (525 crashes) stays unplaced: it meets US 1 at two junctions 1.06 km apart along US 1 (on SRIs `12051747__` MP 0.61 and `12051007__` MP 1.34), leaving it on the same side at both, and its crashes say "E" / "W" of US 1 (361 of 558) or nothing (148), which fits either junction; they're `how` = "junctions".

### R2-2. Partial town-report gaps

**Symptom.** Automatic gap notes fired only below 50% of expected, and said "Most of … missing" for any gap, including Hoboken 2023 (334 vs ~684, i.e. about half) and Weehawken 2014 (225 vs ~461). Newark 2025 (5,646 vs ~13,000) and Hoboken 2024–25 weren't noted at all: the neighbour window was ±3 years with ≥ 4 neighbours, so the last year of the data was never checked, and a multi-year gap depressed its own neighbours' baseline.

**Hoboken 2023 is a real gap.** Hoboken's totals: 836 (2022), 334 (2023), 334 (2024), 345 (2025), vs 865–1,038 in 2017–19 (558 in 2020) while the rest of Hudson is flat (15,050 → 15,380 in 2022–23). The shortfall is in whole months, not spread evenly: Feb 2023 has 5 crashes, Sep–Dec 2024 4 / 2 / 8 / 9, Jan–Mar 2025 7 / 5 / 11, vs ~50–90 a month in 2019–22. Injury and property-damage crashes fall together (injury share 14% in 2023, 14–21% in 2017–22). The per-table 2023 file has the same 335, so it's not an AASHTO-conversion loss. So Hoboken PD's reports for about half of 2023–25 aren't in NJDOT's data. (Fatal crashes, which NJSP data could corroborate, are too few: 0–1 a year.)

**Fix (`road_notes.muni_gaps` / `gap_notes`).**

- Counts are per muni-year-month (`njdot roads build` passes the month).
- A year's expected total is the median of its 6 nearest other years (≥ 4, ≤ 8 years away) that aren't gap years, each scaled by the rest of the county's totals; gaps are re-found without the flagged years until stable (≤ 5 passes).
- Gap: < 50% of expected (as before), or a **partial gap**: < 75%, ≥ 100 crashes short, and more than 3× the town's own year-to-year spread below (robust: 1.4826 × the MAD of its other years' log(observed / expected), ≥ 0.05).
- Near-empty months (< 25% of the year's expected monthly count) are listed as evidence.
- Wording: a gap under 50%, or with near-empty months, is reports missing (`coverage`), with the share in words: "Nearly all / Most / About half / About a third / About a quarter of X's crash reports are missing for Y" and "~55%" in the text. A partial gap without near-empty months could be a change in what the police report (or a real drop): an `unexplained` note, "X has ~30% fewer crash reports than expected for Y", giving the town's usual spread.

Statewide (muni-year-month counts as the build sees them): **149 → 236 gap runs** (shortfall ~58k → ~138k crashes); 206 `coverage` notes and 28 `unexplained` ones (2 runs replaced by curated notes). Most of the growth is longer runs of known gaps (Irvington 2021–23, not 2022–23; Bridgeton 2018–23 as one run) and the series' last year, now checked. New partial gaps include Hoboken 2023–25 (coverage, 8 near-empty months), Paterson 2025 (Oct–Dec 68 / 72 / 66 vs ~500), Newark 2024–25 (below), and uncorroborated ones such as Clifton 2020, Elizabeth 2024 and North Bergen 2025 (~25–30% fewer, every month alike).

Hudson dev build notes: Union City 2022 "Most" (~90%), Weehawken 2014 "About half", Hoboken 2023–25 "About half", Hoboken 2015–16, North Bergen 2025 and West New York 2025 `unexplained` (~30% fewer).

### R2-3. Newark 2023–25

**Symptom.** Round 1's leftover: Newark Broadway 119 / 93 / 37 in 2023–25 (vs ~180), and Newark's total 10,689 / 9,007 / 5,646.

**Root cause: Newark's reports, city-wide, in two steps.** Every Newark street falls alike (2025 vs the 2021–22 average: Broadway 0.21, Avon Ave 0.16, Elizabeth Ave 0.18, Broad St 0.29, McCarter Hwy 0.27, Bergen St 0.31), while I-78 (0.87) and the Turnpike (0.76), which the State Police patrol, hold. By month, crashes on Newark's streets (not interstates, toll roads or ramps):

| | 2021–22 | Sep–Dec 2023 | Jan–Aug 2024 | Sep 2024 – Dec 2025 |
|---|---:|---:|---:|---:|
| Crashes / month | ~870 | ~600 | ~680 | ~280 |
| Injury share | 24% | 36% | 34% | 24% |

From September 2023 property-damage reports fall (~40%) while injury crashes hold (a change in reporting minor crashes, like Jersey City's in 2020); from September 2024 everything falls ~70%, injury and property-damage alike, in a step. That's reports missing from NJDOT's data, not traffic. Broadway's fall is Newark's, a bit steeper.

**Fix.** Curated note `newark-2023-25` (`coverage`, 2023–25, Newark streets); it replaces the automatic `gap-7-14-2024-2025` ("Newark has ~45% fewer …", which dilutes the drop with the unchanged interstate crashes).

### R2-4. 2001–02: county routes coded to state routes' SRIs

**Symptom** (the audit's "2002 cluster", after R2-2's exclusions): many Bergen county roads dip in 2001–02 (`bergen/anderson-avenue` 121 / 45 / 205 in 2001–03 on raw coded crashes; Oradell Ave, Market St, River Rd, Fort Lee Rd, Lake St, Madison Ave …), while roads elsewhere spike in 2002: `warren/west-washington-avenue` (NJ 57) 283 vs ~90, `mercer/state-highway-29` +104, `atlantic/folsom/mays-landing-road`, `union/cranford/lincoln-avenue`, `hudson/jersey-city/wallis-avenue`.

**Root cause.** In 2001–02 NJDOT coded crashes on a (non-500-series) county route to the *state* SRI with the same number: Bergen's "CR 29" → `00000029__` (NJ 29, in Mercer), "CR 57" → `00000057__` (NJ 57, Warren), "CR 10" → NJ 10, "CR 80" → I-80. From 2003 it never happens (1 crash). Statewide 7,052 (2001) and 8,185 (2002) crashes: Bergen 4,918 / 6,406, Ocean 857 (2001), Monmouth 276 / 689, Camden 489 / 493, Passaic 171 / 159. The MPs are the county route's own (Bergen CR 57 by cross street, 2002 state-coded vs 2003–05 `02000057__`: Beech St 0.69 / 0.69, Kaplan Ave 1.03 / 1.03, Madison Ave 2.49 / 2.49), and so are the cross streets ("CR 17" × Faller Dr, Washburn St: Bergen's CR 17, not NJ 17). NJDOT's points (`ilat`) were computed from the wrong SRI: Bergen's "CR 29" crashes sit in Mercer (40.19° N, −74.75°).

**Fix (code).** `loc_recovery.county_route_sris` / `recode_county_routes`, applied by the build (and `njdot roads recover`) before anything else: a 2001–02 crash whose road string names a county route (`route_sri` gives a county-prefixed SRI) and whose coded SRI is `00000` + the same number gets the county route's SRI, MP kept; its NJDOT points are dropped (`drop_coded_points`). Recovery then places them: on a current run as coded, else by cross street (`route_xs`) or calibration; ~2.0k / 2.6k Bergen ones (mostly no MP, retired county SRIs like `02000012__`, "CR 12", that no NG9-1-1 shield carries) stay on no road rather than on a wrong one.

**Before / after** (Bergen `-C 2`): 11,324 crashes recoded. Crashes on a Bergen road: 2001 23,065 → 23,415, 2002 22,539 → 23,011 (2003: 27,145). `nj/nj-10` (Bergen's "CR 10" crashes on NJ 10 by `sri_only`) 215 → 8; Anderson Ave (CR 29) 2002 197 → 254 (2003: 213); Teaneck Rd (CR 39) 2001 266 → 286. Gross moves 3.3k crashes, net +1.5k. Market St, River Rd and Oradell Ave barely move: their 2001–02 crashes are mostly uncoded (police strings like "MARKET STREET" are rarer then: 10 / 9 vs 45 in 2003), so their dips are mostly 2001–02's lower coding rate (Bergen 35% / 41% SRI+MP-coded vs 54% in 2003), not fixable. The spikes elsewhere (Warren, Mercer, Atlantic, Union) need a statewide build to show.

**Residual.** Hoover Ave (Essex, CR 651): 132 / 62 `sri_only` crashes in 2001–02 from Belleville / Bloomfield "CR 651" strings whose cross streets never meet today's CR 651 (Hoover Ave only); left as is ([Open items](#open-items)).

### R2-5. Rockaway Twp CR 513: a placeholder MP (2003–08)

**Root cause.** 2003–08 Rockaway Twp crashes on CR 513 (`00000513__`) are coded MP 42.33–42.38 whatever the cross street (I-80 at 42.33 then, 45.34 in 2001–02 / 2009+; Upper Hibernia Rd 42.34 vs 51.77): 62 / 65 / 83 / 71 / 70 / 19 a year, ~1 a year otherwise. MP 42.3 is East Blackwell St in Dover. In 2006–08 the "police" point (`olat`) equals NJDOT's (computed from the SRI / MP) too.

**Fix.** `recode` override `rockaway-twp-cr513-placeholder-mp` (MP → null). `apply_recodes` now drops the points NJDOT computed from a recoded SRI / MP (`ilat` / `ilon`, and `olat` / `olon` when they're the same point), and the build applies recodes before taking crashes' points. Morris: 369 crashes. Statewide outputs → Morris `-C 14`:

| Year | 2002 | 2003 | 2004 | 2005 | 2006 | 2007 | 2008 | 2009 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| East Blackwell St before | 57 | 121 | 129 | 142 | 119 | 124 | 67 | 37 |
| after | 57 | 59 | 65 | 63 | 49 | 57 | 48 | 37 |
| Green Pond Rd before | 57 | 18 | 18 | 8 | 3 | 10 | 52 | 40 |
| after | 60 | 51 | 37 | 38 | 38 | 42 | 60 | 40 |

The 2006–08 ones needed the `olat` rule: without it 81 snapped back to East Blackwell St from their "police" point. Green Pond Rd's 2003–07 (37–51) is still below 2001–02 / 2008+ (57–70): 204 of the 369 recoded crashes are on no road (145 have no cross street).

### R2-6. Somerville Circle stubs (pair swings)

**Root cause** (the top `pair_swing` findings: Somerville Circle / Easton Turnpike vs US 202 / NJ 28, 0% → 100%). From 2023 NJDOT codes crashes to US 206's second-carriageway SRI `00000206_S`; on it, the build's road-name points at MP 71.25 and 71.30 are named "Somerville Circle" and "Easton Turnpike" (one point each) between two "US Highway 206" stretches. `smooth_names` absorbed a blip only when both sides matched *it*, so two different one-point names side by side made two 0.05-mile roads that only ever get 2023+ crashes. The circle's total is continuous (~260 a year across NJ 28 MP 2.3, US 202 MP 24.4, US 206 MP 71.3 in 2019–22; ~262 in 2023). (The circle's 2008–13 reconstruction doesn't line up with the swing.)

**Fix (code).** `smooth_names` then absorbs runs of several differently named blocks, ≤ `MAX_BLIP_PTS` (3) points in all, between two blocks of one name on the same SRI (`_multi_blips`). Statewide ~13 such runs; Clifton / Passaic's Van Houten Ave (`16000614__`, one-point "Passaic Avenue" / "Lackawanna Place" blips) now one road (`passaic/passaic/van-houten-avenue`, 0.67 mi, merges into `passaic/van-houten-avenue`: 3.30 → 4.02 mi). Somerset `-C 18`: the stubs are gone; US 206 2023–25 353 / 390 / 387 → 372 / 407 / 423.

### R2-7. Coded crashes on a road towns away (re-mileposted routes)

**Symptom.** `passaic/paterson/main-street` 2020 "spike" (205 vs ~90); `union/berkeley-heights/horseshoe-road` with 49% of its 2,197 crashes unplaced; phantom roads named only "ROUTE 509" (`essex/irvington/route-509` 4,858 crashes, `union/westfield/route-509` 986, `passaic/clifton/route-509` 1,593).

**Root cause: NJDOT re-mileposted routes, and old crashes keep old MPs.** CR 509 (`00000509__`) through Paterson sat at MP 23.5–25.5 in 2003–19 and 31–32.5 from 2020, with the same cross streets (Market St, Ward St): the route's MPs moved ~7 mi. Before 2020 Paterson's CR 509 crashes land on the run now at MP 23–27, Bloomfield's Broad St, 12 km away (and their `ilat`, computed on today's network, is there too: 40.82° vs Paterson's 40.91°). Elizabeth's pre-2020 "UNION COUNTY 624" crashes (today North Ave; CR 624 is now only Horseshoe Rd, Berkeley Heights, 15 km away): 1,091 at MP 0–0.7, inside Horseshoe Rd's run, and 1,077 without MP, put on the SRI's one road (`sri_only`). Statewide (from the statewide outputs) 32,157 crashes coded before 2020 sit on a single-county road in another county (1.0%), vs 6,595 (0.5%, border noise) from 2020; the top routes are CR 509 (7,463 over 15 roads), NJ 27 (5,439), I-95, CR 537, NJ 124, CR 577; many more land in the wrong town of the right county (Westfield's East Broad St: 1,185 Hillside CR 509 crashes).

**Fix (code, `loc_recovery`).**

- `far_from_town`: a coded crash is on a road towns away when the point of its `(sri, mp)` on today's network (`Snapper.point`, the inverse of `snap`; else NJDOT's `ilat`) is > 2 km (`TOWN_M`) from every NG9-1-1 street of its muni (`muni_geoms`: each muni's segments, prepared), **and** the road it lands on (`entity_at`; its runs sampled every 0.1 MP) doesn't come within 2 km of the muni either (a mistyped MP on the right road is kept).
- Such crashes are re-located like off-run ones (`recover_unassigned` includes them; their SRI's lines masked; they teach no learned names): by strings (route + cross street, names), else calibration. NJDOT's point is dropped as a clue when it's also out of town (Paterson's), kept when it's in town (Elizabeth's, computed on the network of its day).
- Not re-located, they **keep NJDOT's coding** (`how` = "far_town"): the muni can be what's wrong. Essex Fells has 716 / 1,391 crashes in 2001–02 vs ~340 a year after, including 180 Parkway crashes at East Orange's exits (MP 145–148); Cedar Grove's I-80. Dropping those off every road (a first version) lost correct roads.
- `sri_only`: an SRI without MP goes onto its one road only if that road's lines come within 2 km of the crash's muni (Elizabeth's MP-less CR 624 crashes: off Horseshoe Rd).
- `recover` returns `far_town`; `fold_recovery` keeps a re-located one's recovered point only; the build logs "coded on a road towns away: N crashes, M re-located".

**Before / after** (dev builds; "coded on a road towns away" per build: Essex 5,727 (5,267 re-located), Union 4,178 (4,124), Passaic 781 (720), Hudson 48 (4).

| Road | Crashes before | after | |
|---|---:|---:|---|
| `union/berkeley-heights/horseshoe-road` | 2,197 | 71 | Elizabeth's CR 624 crashes leave; Berkeley Heights' own stay |
| `union/north-avenue` | 3,379 | 4,466 | … to Elizabeth's North Ave (old CR 624), by cross street (Pennsylvania Ave, US 1, Madison Ave …) |
| `union/hillside/liberty-avenue` | 573 | 1,490 | Hillside's CR 509 crashes, from Westfield's East Broad St / "ROUTE 509" |
| `union/westfield/east-broad-street` | 2,037 | 1,714 | |
| `union/union-twp/fairway-drive-east` | 414 | 30 | Linden's CR 656 crashes → East Linden Ave, Park Ave |
| `essex/bloomfield/broad-street` | 737 | 2,627 | Bloomfield's CR 509 crashes, from `essex/grove-street` / "ROUTE 509" (2012–18: 1–13 → 123–148 a year) |
| `essex/verona/mount-prospect-avenue` | 203 | 682 | Verona's CR 577 crashes, from West Orange's Mount Pleasant Ave |
| `passaic/paterson/main-street` | 3,414 | 3,927 | 2015–19: 124 / 90 / 113 / 125 / 125 → 162 / 120 / 205 / 177 / 248; 2020: 205 → 207 (the "spike" was the old level returning) |
| `essex/garden-state-parkway` | 37,781 | 37,780 | the 180 Essex Fells–coded Parkway crashes (MP 145–148, East Orange's exits) stay: not re-located, kept as coded |

The dev builds' "ROUTE 509" roads (CR 509 runs outside the county's NG9-1-1 names) keep only their own town's crashes (Irvington's MP 8–11). Statewide, re-located crashes also leave other counties' roads (`union/boulevard`: 1,683 Passaic / Essex CR 509 crashes by the fork's count); a statewide build will show it.

### R2-8. Summit Ave: calibrating onto a road of several SRIs

**Root cause.** All 3,305 crashes coded to Hudson's retired `09000617__` ("HUDSON COUNTY 617", Summit Ave: cross streets Irving, Leonard, Pavonia, Hague, Sip, Academy …) were on no road. `calibrate_retired` calibrates onto the current SRIs near ≥ half of a retired SRI's anchors (`CAL_SRI_SHARE`), and today's Summit Ave is 7 local SRIs, the longest 1.7 of its 4.6 mi: none qualifies. (The next largest retired SRIs mostly calibrate: `09000612__` 565 of 3,064 off, `09000644__` 479 of 1,173.)

**Fix (code).** `calibrate_retired(runs=)`: when no one SRI is near half the anchors, each anchor's nearest line → its road (`entity_at`), and the road nearest ≥ half the anchors gives the SRIs to snap onto.

Summit Ave (4.6 mi, JC / Union City) per year, before → after:

| | 2001 | 2003 | 2005 | 2008 | 2011 | 2012 | 2013 | 2014 | 2016 | 2017 | 2018 | 2019 | 2022 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| before | 142 | 85 | 75 | 204 | 80 | 89 | 77 | 186 | 194 | 49 | 104 | 265 | 161 |
| after | 361 | 359 | 267 | 268 | 283 | 305 | 332 | 303 | 342 | 291 | 254 | 265 | 161 |
| police strings naming Summit / CR 617 (Hudson) | | 396 | | 306 | | 326 | | | 358 | | | 272 | 166 |

The new series follows the police strings (every crash on it names Summit Ave or CR 617); the 2014 "spike" and 2017 "dip" were years with fewer / more crashes coded to the retired SRI. Hudson: +3,003 crashes on a road (all Summit Ave, 2001–18); 2019+ is unchanged, so its step down from ~300 to ~170–265 is the city's (JC's 2020 property-damage drop, [§ 1](#1-west-side-ave-jc-2019--2020-drop)).

### R2-9. More data notes

Curated notes added (`njdot/data/road_notes.yml`; 15 in all), each for a verified break the data can't fix:

| Note | Kind | Years | Finding (audit) | Evidence |
|---|---|---|---|---|
| `newark-2023-25` | coverage | 2023–25 | Newark Broadway 119 / 93 / 37 | R2-3 |
| `flemington-circle-coding` | coding | all | `pair_swing` NJ 31 vs US 202 (Hunterdon, 1% / 73%) | Circle crashes are coded to US 202 (MP ~11.4) or NJ 31 (MP ~22.0): 264–349 per three years throughout, NJ 31's share ~40% (2001–06) → 5–13% (2010–21), 22% (2022–24) |
| `woodbridge-green-st-us9` | reporting | 2016–25 | `pair_swing` Green St vs US 9 (0% / 82%) | Reports under Green St × US 9: 163 (2007–09) → 11–17 per three years from 2016; under US 9 × Green St ~115–180 throughout (the two together also fall, ~320 → ~130–150) |
| `port-authority-2019-22` | coverage | 2019–21 | corridor `hudson/state-highway-495` 2019 "dip" (325 vs 713) | Port Authority crashes on the Lincoln Tunnel / NJ 495 corridor grow 234 / 263 / 431 / 524 (2019–22; statewide 1,350 → 2,526, through 2020); other crashes ~90–100 a year |
| `pip-police-2013-18` | coverage | 2013–18 | PIP 2018 dip / 2019 spike | PIP-coded crashes 134–241 a year in 2001–12, 27 in 2013, 0–2 in 2014–18, 237 in 2019 (Parkway Police reports) |
| `mannington-pennsville-pd-2011-14` | reporting | 2011–14 | Salem–Woodstown Rd 2012–13 spike (101 / 61 vs ~30) | Pennsville PD reports Mannington's crashes (193 / 355 / 242 / 185 vs ~80 before); the town's total 166 → 252 / 393 / 264 / 259 → 115 |
| `secondary-carriageway-2023` | coding | 2023–25 | Englewood Dean St 2023–24 spike | Secondary SRIs (`…_S`) have 0 crashes in 2001–22, 7,272 / 20,421 / 24,035 in 2023–25; Dean St (CR 501's second carriageway) ~0 → 63 / 103 / 114 while Grand Ave / Engle St (CR 501) ~210 → 153 / 123 / 92, together continuous. Selects roads with an `…_S` SRI but not its main `…__` one (a regex with a back-reference) |
| `us1-truck-coding` | coding | all | Wallis Ave 2002 / 2019 spikes, US 1&9 Truck 2006–07 dip | `00000001T_` crashes 382 / 575 (2001–02), 47–80 (2006–09), 153–376 (2010+); Charlotte Circle crashes on Wallis Ave's MPs (3.55–3.80) in 2001–02 / 2019–20, below them in 2003–18 |

Not noted: `salem/north-virginia-avenue` 2013 (15 / 25 / 28 State Police reports in 2011–13 at one US 130 MP, 4.00–4.02: small).

### R2-10. Audit: noted years

`yoy_breaks(exclude=)`: a road's noted years (`noted_years`: a town's missing reports, a coding change) neither set other years' expectations nor are checked; a year's window widens by as many years as it loses. Before, the year after a gap was compared with the gap: Pleasantville's South Main St 2024 "spike" (41 vs 0), Riverdale's Paterson–Hamburg Tpk 2024, West Long Branch's Monmouth Park Hwy 2024, Plumsted's Pinehurst Rd 2007–08 (before its 2009–14 gap). Corridors: a year is noted when members holding ≥ half the corridor's crashes are (`corridor_noted_years`: Bridgeton's Broad St, all in Bridgeton). On the statewide outputs with this branch's notes (`tmp/sw_notes.py`, before R2-4–R2-9's fixes): remaining `yoy` findings 200 → 157, `corridor_yoy` 122 → 47, `pair_swing` 1,937 → 1,914; with R2-9's notes too, 149 / 44 / 1,913.

### R2 code changes, dev-build totals, rebuild

| File | Change |
|---|---|
| `njdot/loc_recovery.py` | `junctions` (replaces `cluster_point`), several-junction choice by offset / direction, `offset_along` across nodes (R2-1); `county_route_sris` / `recode_county_routes` / `drop_coded_points` (R2-4); `muni_geoms`, `far_from_town`, `Snapper.point`, `sri_only` town check, `recover(muni_geoms=)` → `far_town` column (R2-7); `calibrate_retired(runs=)` (R2-8). `recovery_context` adds `muni_geoms`. |
| `njdot/road_notes.py` | `muni_gaps`: month counts, iterated nearest-year baseline, partial gaps; `gap_notes`: share wording, `unexplained` partial gaps (R2-2). |
| `njdot/road_anomalies.py` | `yoy_breaks(exclude=)`, `noted_years`, `corridor_noted_years`, `corridor_yoy(exclude=)` (R2-10). |
| `njdot/road_overrides.py` | `apply_recodes` drops the recoded crashes' NJDOT points. |
| `njdot/cli/roads.py` | build: county-route recode and `recode` rules before points are taken; muni-year-month counts; logs ambiguous junctions and far-from-town counts. `fold_recovery`: far-from-town points. `smooth_names` / `_multi_blips` (R2-6). `audit-anomalies`: noted years excluded. |
| `njdot/cli/loc_recovery.py` | `recover -E/--eval-out`; `load_crashes` applies `recode_county_routes`. |
| `njdot/data/road_overrides.yml` | + `rockaway-twp-cr513-placeholder-mp`. |
| `njdot/data/road_notes.yml` | + 8 notes (R2-3, R2-9). |

Tests (exact equality): `test_loc_recovery.py` (junctions, offsets across a node, several junctions, `recode_county_routes`, `Snapper.point` / `far_from_town`, `sri_only` town check), `test_road_notes.py` (partial gaps, wording), `test_road_overrides.py` (noted years, corridor noted years, recode drops points), `test_road_model.py` (calibration onto a road of several SRIs), `test_roads.py` (multi-block name blips). 119 pass.

**Dev-build totals** (county builds, HEAD code → this branch; the "before" builds already had the Rockaway rule and this branch's YAML, read from the worktree):

| Build | Crashes on a road | Without a map point | County routes recoded | Ambiguous junctions | Towns away (re-located) |
|---|---|---|---:|---:|---|
| Hudson `-C 9` | 406,339 → 410,015 | 66,301 → 51,702 | 170 | 690 | 48 (4) |
| Essex `-C 7` | 610,713 → 610,911 | 70,583 → 62,984 | 6 | 1,240 | 5,727 (5,267) |
| Middlesex `-C 12` | 599,880 → 601,110 | 47,206 → 33,411 | 114 | 3,690 | 366 (78) |
| Bergen `-C 2` | 621,638 → 622,983 | 51,863 → 34,714 | 11,324 | 1,221 | 396 (210) |
| Passaic `-C 16` | 374,450 → 375,678 | 46,288 → 38,548 | 330 | 2,519 | 781 (720) |
| Union `-C 20` | 438,128 → 437,375 | 33,329 → 24,749 | 24 | 858 | 4,178 (4,124) |
| Morris `-C 14` | 318,572 → 318,640 | 17,398 → 11,682 | 2 | 1,207 | 117 (33) |
| Somerset `-C 18` | 240,600 → 240,681 | 10,884 → 5,630 | 4 | 719 | 62 (7) |

Union loses 753 on-road crashes: Elizabeth's MP-less CR 624 crashes leave Horseshoe Rd and most can't be placed.

**Rebuild.** A statewide `roads.dvc` rebuild (Batch) is needed: `loc_recovery.py`, `road_notes.py`, `road_anomalies.py`, `road_overrides.py`, `cli/roads.py`, `road_notes.yml`, `road_overrides.yml` changed (all already `git_deps`; no new module, so no new `git_deps` entries). Expected statewide: ~15k more crashes with a point per county-sized area (the `offset_along` fix; Hudson −14.6k without a point), 15.2k 2001–02 county-route crashes re-coded (the Warren / Mercer / Atlantic / Union 2002 spikes gone), ~30k+ re-mileposted crashes moved to their own town's road (CR 509, NJ 27, CR 624 …), Summit Ave +3.0k, more / reworded gap notes (236 runs), 8 more curated notes. Then rerun `njdot roads audit-anomalies` on the output.

## Data notes

`njdot/data/road_notes.yml` (curated) + automatic coverage gaps → **`road-notes.parquet`** in the roads outputs (`njdot/road_notes.py`). For road / corridor pages to show beside per-year counts; no frontend in this branch.

**YAML** (one entry per note):

```yaml
- id: jersey-city-pdo-2020          # unique; the `note` column
  kind: reporting                   # reporting | coverage | coding | unexplained
  years: [2020, 2025]               # optional: the years it explains (inclusive; or one year)
  title: Jersey City reports fewer property-damage crashes since 2020
  text: >                           # whitespace-collapsed
    Jersey City's property-damage-only crash reports fell 42% in 2020 …
  where:                            # all must hold; ≥ 1 key
    cc: 9                           # county / muni the road runs through (scalar or list)
    mc: 6
    subt: [2, 3, 5, 6, 7]           # road classes (muni-police notes: not interstates / toll roads / ramps)
    # slug / name: full-match regexes; sris: regex searched in the road's SRIs; bbox: [w, s, e, n] (bbox center)
  corridors: true                   # optional: also the selected roads' corridors and all their members
```

- `kind`: `reporting` (an agency reports differently), `coverage` (crashes missing from NJDOT's data), `coding` (NJDOT codes locations differently), `unexplained` (a verified break, cause unknown).
- `cc` / `mc` match any muni the road's points are in (not only `road-entities.mc`, which is null for multi-muni roads).
- The build raises on a duplicate id, an unknown `kind` / `where` key, an empty `where`, or a missing `title` / `text`.

**`road-notes.parquet`:**

| Column | Type | |
|---|---|---|
| `entity` | int32? | the road (null on a corridor row) |
| `corridor` | int32? | the corridor (null on a road row) |
| `note` | string | note id (`gap-<cc>-<mc>-<y0>[-<y1>]` for automatic gaps) |
| `kind` | string | as above |
| `year_lo`, `year_hi` | int16? | the years it explains (null: all) |
| `title`, `text` | string | |

One row per (road, note) and per (corridor, note). **Sort:** `(entity, corridor, note)`, nulls last. **Row groups:** 10,000. **Stats:** `entity`, `corridor`. **Dict:** `note`, `kind`, `title`, `text`. Hudson dev build: 723 rows (7 notes). Statewide estimate: ~5–10k rows (a JC-wide note is ~500 rows; 149 gaps × ~50 roads), well under 1 MB.

Frontend sketch (not built): on a road page, `road-notes WHERE entity = ?` (and `WHERE corridor = ?` on a corridor page); shade `year_lo..year_hi` on the per-year plot and show `title` / `text`.

## Code changes

| File | Change |
|---|---|
| `njdot/loc_recovery.py` | `recover`: "coded" means on a current run; off-run crashes on a current SRI are re-located by name (their SRI's lines masked), then calibrated within `CAL_EXTEND_MI`. `calibrate_retired`: no ramp targets for a route. `_locate_strings`: a road name aliased onto its cross street meets it at its own segments. |
| `njdot/road_model.py` | `corridor_pairs`: freeway continuations (`FREEWAY_SUBT`, `STREET_NAME_RE`). `road_corridors`: spine skips `AUX_NAME_RE` names. |
| `njdot/road_overrides.py` | `recode` rules (`RECODE_KEYS`, `RECODE_WHERE_KEYS`, `apply_recodes`); `apply_overrides` seeds `override` from `_recode`. |
| `njdot/road_notes.py` (new) | notes: load / validate, `note_mask`, `road_notes`, `muni_gaps`, `gap_notes`. |
| `njdot/road_anomalies.py` | `corridor_yoy`, `absorbed`, `noted`; `yoy_breaks` scales a road in no one county by the state. |
| `njdot/cli/roads.py` | `build`: `-N/--notes`; applies recodes before recovery; muni-year counts → gaps → `road-notes.parquet`. `audit-anomalies`: corridor breaks, absorbed / noted findings dropped. |
| `njdot/data/road_overrides.yml` | first rule: `newark-broadway-cr649` (`recode`). |
| `njdot/data/road_notes.yml` (new) | 8 curated notes. |
| `www/public/njdot/roads.dvc` | `git_deps` += `/njdot/road_notes.py`, `/njdot/data/road_notes.yml` (empty values: recorded by the next run). |

Tests (all exact-equality): `test_road_model.py` (freeway continuations / spine; calibration skips ramps), `test_loc_recovery.py` (off-run crashes in `test_recover_real`; road aliased onto the cross street), `test_road_overrides.py` (`recode` rules and validation; `corridor_yoy` / `absorbed`; `noted`), `test_road_notes.py` (new: notes, validation, `muni_gaps` / `gap_notes`), `test_roads.py` (the new file). 109 pass.

## Audit changes

`njdot roads audit-anomalies`:

- **`corridor_yoy`** (new kind): `yoy` on `road-corridor-summary`.
- A member road's `yoy` finding, or a `pair_swing` of two members of one corridor, is dropped when the corridor has no `corridor_yoy` finding overlapping those years: the corridor absorbs it. On the statewide v5.1 outputs: 123 of 522 `yoy` and 836 of 2,756 `pair_swing` findings (the Turnpike express swarm that filled the top of all three lists is gone).
- A `yoy` finding a `road-notes` row explains (same road, overlapping years) is dropped (needs a build with notes).
- A road in no single county (a statewide corridor) is scaled by the state's totals (was: unscaled).

Top remaining findings on the v5.1 statewide outputs (before this branch's fixes and notes): Fort Lee I-95 Express and Kearny's West Alignment 2023–24 (fixed: now corridor members), Newark Broadway (fixed / noted), the Pleasantville / Bridgeton / Deptford / Boonton / Edgewater town gaps (now noted), `essex/newark/new-jersey-turnpike-extension` 2021–22 dip / 2024 spike (now in the I-78 corridor), Somerville Circle vs US 202 / NJ 28 pair swings (not investigated).

## Dev-build totals

Crashes on a road (`crashes-by-entity` rows), v5.1 → this branch:

| Build | Before | After | Δ | Without a point (before → after) |
|---|---:|---:|---:|---:|
| Hudson `-C 9` | 404,483 | 406,339 | +1,856 | 66,217 → 66,301 |
| Essex `-C 7` | 609,987 | 610,713 | +726 | 70,335 → 70,583 |
| Bergen `-C 2` | 620,878 | 621,638 | +760 | 52,094 → 51,863 |
| Middlesex `-C 12` | 595,852 | 599,880 | +4,028 | 47,506 → 47,206 |

Recovery `loc_source` changes (Middlesex): `sri_calib` 1,174 → 2,651, `latlon_snap` 1,658 → 2,851, `route_xs` 23,439 → 24,470, `intersection` 71,873 → 72,522, `name_only` 42,795 → 42,526. West Side Ave (JC), J F Kennedy Blvd and Tonnelle Ave are unchanged.

## Rebuild

A statewide `roads.dvc` rebuild (Batch) is needed for any of this to reach the site: `roads.dvc` is stale (code deps changed; two new `git_deps`). Expected: `road-notes.parquet` (new file), a few thousand more crashes on roads statewide (the off-run recovery: up to ~22.7k candidates), the freeway rule's 20 new pairs (~15 roads join corridors; 4 corridors merge into the I-78 and GSP ones), the Turnpike corridor renamed `nj/new-jersey-turnpike` (slug change: corridor ids are slug ranks, so ids shift). Then rerun `njdot roads audit-anomalies` on the output.

## Open items

Round 1's triangle junctions, Newark 2023–25, partial coverage gaps and Somerville Circle are done in round 2 (R2-1, R2-3, R2-2, R2-6). Still open:

- **Cross streets with "/"** (`road_model.cross_keys`): "NORTH AVE / NORTH AVE E" becomes one key that names no road, so Elizabeth's US 1 crashes at North Ave (69 / 68 / 47 / 49 a year in 2020–23) aren't at the intersection (0 / 4 / 2 / 0 are); statewide, cross streets with "/" reach a node 55% of the time vs 62% without (~700k crashes, 2005–24). Fix: split on "/", "&", "AND" and add each part's keys (and `route_keys` of each: "US 1 / US 9 / …" gives only `R:US1`). Changes node association broadly: needs a before / after of `n_node` per road.
- **US 1&9 Truck coded as US 1 without MP (2006–09)**: Jersey City / Kearny crashes with Truck-route cross streets (Charlotte Ave, Duncan, Communipaw, County Rd; 280 in 2006–09) are on no road: US 1 is several roads in Hudson and the cross streets don't meet its lines. Fix: when a route coded without MP doesn't meet its cross street, try the route's sibling SRIs in the county (`00000001T_`); noted for now (`us1-truck-coding`).
- **`sri_only` against a cross street that never meets the SRI** (Hoover Ave, Essex: 2001–02 "CR 651" crashes in Belleville / Bloomfield, 132 / 62, whose cross streets never meet today's CR 651): return none, like the name rule; needs a count of what else it moves.
- **McCarter Hwy (Passaic, NJ 21)**: 2,894 crashes coded NJ 21 without MP (2001–18), on the right road but without a point; 1,825 have no cross street, ~280 say "EXIT 10–13". An exit → point table would place those.
- **Secondary-carriageway roads' main line**: `secondary-carriageway-2023` notes the separately named second carriageway (Dean St), not the main-line road that loses those crashes in 2023 (Grand Ave / Engle St); a `where` for "roads carrying a noted SRI's main route over the same MPs" would.
- **Kearny Ave 2001–02** (133 / 126 by name) vs 2003–10's calibrated 64–88.
- **Precision of off-run / far-from-town calibration.** v5's held-out calibration eval (97.5% same entity) was on fully retired SRIs; off-run and re-mileposted crashes weren't evaluated separately. Spot checks (Kearny Ave, Boulevard East, Parsonage Rd, Matawan Rd, Paterson Main St, Hillside Liberty Ave) agree with the road strings.
- **Partial gaps without near-empty months** are `unexplained`; a per-department view (`pdn`, 2001–22) could tell missing reports from reporting changes for them.

[`road-model-v5.md`]: road-model-v5.md
[`crash-location-recovery.md`]: crash-location-recovery.md
