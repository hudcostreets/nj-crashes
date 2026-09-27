# Road anomalies: findings and fixes

**Status:** branch `road-anomalies` (from `map-mode-heatmap-on-cells`). Code, overrides and data notes are in; verified on the Hudson / Essex / Bergen / Middlesex dev builds (`njdot roads build -C <cc>`). **Needs a statewide `roads.dvc` rebuild** to reach the site (see [Rebuild](#rebuild)).

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

- **Triangle junctions.** A road meeting its cross street at two points ~100–150 m apart clusters to their mean, which can be > 30 m (`SNAP_M`) from the road's line, so the snap fails (North Bergen West Side Ave × Paterson Plank Rd / CR 681). Snapping the meet point nearest the mean would place these; it changes every multi-meet intersection's point, so it needs the precision eval.
- **Newark 2023–25** (Broadway 119 / 93 / 37; Newark 60% of expected in 2025).
- **Partial coverage gaps** under the 50% threshold, and a per-department (`pdn`) view for 2001–22.
- **Kearny Ave 2001–02** (133 / 126 by name) vs 2003–10's calibrated 64–88.
- **Somerville Circle vs US 202 / NJ 28** pair swings (0% → 100%), not investigated.
- **Precision of off-run calibration.** v5's held-out calibration eval (97.5% same entity) was on fully retired SRIs; off-run MPs on current SRIs weren't evaluated separately. Spot checks (Kearny Ave, Boulevard East via police points, Parsonage Rd, Matawan Rd) agree with the road strings.

[`road-model-v5.md`]: road-model-v5.md
[`crash-location-recovery.md`]: crash-location-recovery.md
