# Road-name normalization + road-scoped crash queries

## Motivation

2026-08-20, HCCS Slack: Talya asked for "crashes on JFK Blvd for the last 5
years, broken down into severity" — needed same-day, for a reporter. Andrew
ran NJDOT's AASHTO dashboard filtered to "JFK & intersecting streets" and got
**200 crashes / 31 injuries in 5 years**, which he correctly flagged as
implausible. He then found the cause himself:

> Most of the crashes are coded as RT 501 (and variations of such).

The real answer, computed here from `crashes.parquet` + `aashto_supplemented_crashes.parquet`:

| Year | Crashes | Fatal crashes | Killed | Injury crashes | Injured |
|------|--------:|--------------:|-------:|---------------:|--------:|
| 2021 | 1,096 | 2 | 2 | 248 | 325 |
| 2022 | 1,137 | 1 | 1 | 253 | 349 |
| 2023 | 1,203 | 2 | 2 | 278 | 360 |
| 2024 | 1,442 | 1 | 1 | 308 | 407 |
| 2025 | 1,223 | 0 | 0 | 273 | 352 |
| **Total** | **6,101** | **6** | **6** | **1,360** | **1,793** |

**~30× larger than his first report.** Andrew re-pulled and by 15:35 had a
corrected chart (2022–2026, KABCO): O 4,468 / C 643 / B 404 / A 66 / K 5,
**5,586 total** — which agrees closely with ours (see *Cross-validation*
below). So the answer was reachable. But reaching it took a domain expert
noticing an implausible number, re-pulling, and then **hand-classifying rows in
a spreadsheet** — his working file (`JFK Crash 2022-2026`, 4.1 MB) is a broad
Hudson County export with a manually-added **`JFK?` column**; the sampled rows
are `JAMES AVE`, `ST PAULS AVE`, `COOPER ST`, `67TH ST`/`BERGENLINE`, i.e. the
whole county, filtered by hand.

That manual labor is what this spec eliminates. It is the single most-requested
thing the site can't do today: *"give me the crash history for this street."*
Ryan's reply in-thread ("I want to support filtering to specific roads but
haven't built it") is the commitment this spec discharges.

## The core finding: this is entity resolution, not full-text search

The obvious framing — "build an FTS index over `road`" — **does not solve the
problem**, and it's worth being precise about why before designing anything.

Hudson County, 2016+, every row whose `road` text mentions JFK/Kennedy:

| `sri` | rows | distinct `road` variants |
|-------|-----:|--------------------------|
| *(no sri)* | 368 | 132 — mostly house-numbered: `1347 JFK BLVD`, `3080 JFK BLVD (7 ELEVEN)` |
| `09111121__` | 196 | `JOHN F KENNEDY BLVD E / PARK AVE`, `John F Kennedy Boulevard East` |
| `00000501__` | 181 | `Rt 501 (Kennedy Boulevard)` |
| `00000501_S` | 6 | `Rt 501 Secondary (Kennedy Boulevard)` |
| `09000690__` | 6 | `Kennedy Boulevard (HUDSON COUNTY 690)` |
| `09011547__` | 6 | `JFK Boulevard`, `JFK BLVD` |

Total: **~760 rows.** Meanwhile the corridor's actual bulk is **9,447 rows
whose `road` is the bare string `ROUTE 501`** — containing neither "JFK" nor
"Kennedy". An FTS query for `JFK` returns ~8% of the corridor. FTS is the
*retrieval* layer; the missing piece is an *alias graph* saying
`Route 501 ≡ JFK Blvd` in Hudson County.

Three further complications the data surfaces:

1. **`SLD_NAME` doesn't rescue us.** `nj_mp_tenths.parquet` is NJDOT's
   canonical straight-line-diagram gazetteer (SRI → `SLD_NAME`,
   `Second_Name`, lat/lon per tenth-mile) and is already in the repo driving
   `hex-sld`. But it names `00000501__` as literally **`ROUTE 501`** with
   `Second_Name` NULL. Every Kennedy-named SRI in that table is in a *different*
   county (`18`=Somerset, `15`=Middlesex, `07`=Essex, `12`=Mercer…). **No
   existing table in this repo links the colloquial name to the route number.**
2. **Near-miss roads must not merge.** `09111121__` "John F Kennedy Boulevard
   East" is a *distinct* road (the Palisades-top boulevard through
   Weehawken/West New York/Guttenberg), not part of JFK Blvd proper. A naive
   `LIKE '%KENNEDY%'` silently over-counts by ~200.
3. **House-number prefixes.** 132 of the free-text variants are addresses
   (`3139 KENNEDY BLVD`), not street names. Normalization must strip leading
   house numbers before matching.

## Severity granularity: KABCO is already in our data

Talya asked for three tiers — "all crashes, and then serious and fatalities."
The crash-level `severity` field is only `f`/`i`/`p`, which **cannot express
"serious"**. But the full KABCO scale *is* present, per-person, on
`occupants` + `pedestrians` as `condition`, with the mapping already written
down in `njdot/codes.py:46`:

| `condition` | KABCO | |
|---|---|---|
| 1 | K | Fatal Injury |
| 2 | A | Suspected Serious Injury |
| 3 | B | Suspected Minor Injury |
| 4 | C | Possible Injury |
| 5 | O | No Apparent Injury |

Crash-level severity is then `min(condition)` over occupants ∪ pedestrians
(1 = worst), with no person rows → `O`. This is an **aggregation we don't
currently expose, not missing data**. Surfacing a `kabco` column on the crash
tables is a small, independently useful change that this spec depends on —
without it, road pages can't answer the question that motivated them.

### Cross-validation

Computing per-crash KABCO for JFK Blvd 2023–2025 from our data, against
Andrew's independently-extracted 2022–2026 chart:

| KABCO | Ours (2023–25) | share | Andrew's | share |
|---|---:|---:|---:|---:|
| O No Apparent | 3,037 | 78.8% | 4,468 | 80.0% |
| C Possible | 466 | 12.1% | 643 | 11.5% |
| B Suspected Minor | 305 | 7.9% | 404 | 7.2% |
| A Suspected Serious | 45 | 1.17% | 66 | 1.18% |
| K Fatal | 3 | 0.078% | 5 | 0.090% |
| **Total** | **3,856** | | **5,586** | |

Normalized per year: ours 1,285 crashes / 15 serious / 1.0 fatal; Andrew's
1,188 / 14 / 1.06. **Two independent extractions agreeing within 1–2pp on
every tier** — this validates both his corrected pull and the `is_jfk`
road-matching definition prototyped here, and it is the strongest available
evidence that the alias approach in this spec recovers the true corridor.

## Data inventory

| Field | `crashes.parquet` (2001–2023) | `aashto_supplemented_crashes.parquet` (2023–2025) |
|-------|------|------|
| `sri` | present; **28% null (2016) → 7% (2023)** | present; **7% (2023) → 3.0% (2025)** |
| `road` | free text, ~0% null | free text |
| `cross_street` | free text | free text |
| `route`, `mp` | present | present |

So SRI is a *good but not sufficient* key: 3–7% null in recent years, up to
28% in older ones. Free text is ~100% populated but unnormalized. **Neither
alone is enough; the design must union them.**

`nj_mp_tenths.parquet` (SRI, MP, SLD_NAME, Second_Name, lon, lat) is the
geometry + canonical-name authority, already DVX-tracked.

## Design

### Layer 1 — `roads.parquet`: one row per road entity

Keyed by SRI. Built by a new `njdot build-roads` CLI subcommand.

```
sri            00000501__
cc             9
canonical_name ROUTE 501          -- from SLD_NAME
display_name   John F. Kennedy Blvd  -- best colloquial name (see aliases)
aliases        [JFK BLVD, KENNEDY BLVD, JOHN F KENNEDY BLVD,
                Rt 501 (Kennedy Boulevard), CR 501, ...]
route_num      501
mp_min, mp_max 0.0, 53.05
munis          [0906, 0909, 0912, ...]
bbox           minlon, minlat, maxlon, maxlat   -- from nj_mp_tenths
n_crashes      9583
```

**Alias sources, in precedence order:**

1. **Self-labeling rows.** `Rt 501 (Kennedy Boulevard)`, `KENNEDY BLVD CR 501`,
   `Kennedy Boulevard (HUDSON COUNTY 690)` — these literally contain both the
   route designation and the colloquial name. Parse
   `^(?:Rt|Route|CR)\s*(\d+)\s*(?:Secondary\s*)?\((.+)\)$` and the inverse
   `^(.+?)\s+(?:CR|RT|ROUTE)\s*(\d+)$`. **This is the bridge that makes
   `Route 501 ≡ JFK Blvd` derivable from our own data, with no external
   gazetteer.**
2. **SRI co-occurrence.** Every distinct normalized `road` string observed with
   a given SRI is an alias of that SRI, weighted by row count. Cheap, high-yield.
3. **`SLD_NAME` + `Second_Name`** from `nj_mp_tenths`.
4. **Manual overrides** in `njdot/data/road_aliases.yml`, hand-curated for the
   corridors that matter (JFK Blvd, Bergenline, Kennedy Blvd East, Tonnelle,
   Communipaw, Broadway…). Escape hatch for whatever mining misses; small and
   reviewable.

`display_name` prefers a curated override, then the highest-count colloquial
alias, then `SLD_NAME`.

### Layer 2 — `norm_road`: normalized free text for the SRI-null rows

A pure function, shared verbatim between the Python builder and the TS client
(same rules, tested against each other — a fixture file of input→output pairs
consumed by both test suites, so they can't drift):

- uppercase, collapse whitespace, strip punctuation except `/`
- **strip leading house number** (`^\d+\s+` — but *not* when the whole token is
  the road name, e.g. `ROUTE 501`, and not `36 TH KENNEDY BLVD`)
- strip trailing parentheticals (`(7 ELEVEN)`)
- expand abbreviations: `BLVD→BOULEVARD`, `AVE→AVENUE`, `ST→STREET`,
  `RD→ROAD`, `DR→DRIVE`, `HWY→HIGHWAY`, `CR/RT/RTE→ROUTE`, `E/W/N/S→EAST/…`
  (directional expansion only in prefix/suffix position)
- normalize `J F K`/`JFK`/`JOHN F KENNEDY` → `JOHN F KENNEDY`
- split `A / B` intersection strings into both component names

Each crash then resolves to a road entity by: **`sri` if present → else
`norm_road` matched against the alias set, scoped to `cc`** (county scoping is
what keeps `KENNEDY DR` in Mercer out of a Hudson query).

### Layer 3 — retrieval

**FTS5 in D1** over `roads` (not over crashes): `display_name`, `canonical_name`,
`aliases`, `route_num`. ~10⁴–10⁵ rows statewide — trivially small, and it means
a query for "JFK" hits *one* road row and then fans out to all 9,583 crashes by
`sri`, instead of trying to text-match 9,447 rows that don't contain the term.

Then `GET /v1/roads/search?q=jfk&cc=9` → ranked road entities, and
`GET /v1/roads/{sri}/crashes?y=21-25` → the crash set.

The same `roads.parquet` ships to the client for DuckDB-WASM so `/sql` and the
map can filter without a round-trip.

### Layer 4 — UI

- **Omnibar** (`use-kbd`, already wired for counties/munis): roads become a
  fourth result category. Type "JFK" → "John F. Kennedy Blvd (Route 501),
  Hudson County — 9,583 crashes".
- **Road pages** at `/road/{sri}` (or a slug): the severity-by-year table above,
  the crash list, and the map zoomed to the road's bbox with non-corridor
  crashes dimmed. This is *exactly* the artifact Talya asked for, self-serve.
- **Map click-through**: reuses roadmap item (g)'s table-below-map plumbing.

## Why not just geometry?

Buffer the road's `nj_mp_tenths` polyline and take crashes within N meters —
appealing, and it sidesteps naming entirely. Rejected as the *primary* key
because: crash lat/lon is itself often SRI/MP-interpolated (circular), a buffer
on a dense urban grid catches the cross-street's crashes too, and it can't
answer "which road is this?" for the 3–28% with no SRI. **Good as a
cross-check** — flagging entities whose free-text-matched crashes fall far
from the SRI geometry is a strong QA signal for the alias miner, and is how
this spec proposes to validate output.

## Validation

The JFK table at the top of this doc is the acceptance test — a golden fixture
asserting exact per-year counts — and the KABCO cross-validation table above is
a second, source-independent check (our shares must stay within ~2pp of
Andrew's manual extract). Plus:

- Alias-miner precision: hand-audit the top ~100 Hudson roads by crash count.
- **Negative test: `JFK Blvd East` (`09111121__`) must resolve to its own
  entity**, never merge into Route 501.
- Statewide sanity: share of crashes resolving to *some* road entity, by year;
  expect ≥95% recent, lower pre-2019 where SRI is sparse.
- Round-trip the `norm_road` fixture file in both Python and TS test suites.

## Open questions

1. **Corridor vs. SRI.** JFK Blvd is `00000501__` *plus* `00000501_S` plus
   county SRIs `09000690__`/`09000693__`/`09011547__`. Users mean "the whole
   corridor." Add a `corridor_id` grouping several SRIs, curated in the
   overrides YAML? Leaning yes — it's the unit people actually ask about, and
   the JFK case already needs it.
2. **Cross-street indexing.** Talya's ask was the corridor; Andrew's filter was
   "JFK & intersecting streets". Indexing `cross_street` too enables
   intersection-level queries ("JFK & Communipaw") — high value, and roadmap
   item (j) already wants cross-street naming for hex labels. Probably phase 2.
3. **Where does the alias table live for editing?** YAML in-repo is simplest;
   `crowdsourced-edits.md` imagines a review queue. Start with YAML.
4. Do we backfill SRI for the older sparse years via geometry snapping, or
   accept lower recall pre-2019?

## Relationship to other specs

- Roadmap **(g)** map click-through → crash list: road pages reuse it.
- Roadmap **(j)** hex → readable location name: same `nj_mp_tenths` snapping;
  the cross-street routing (j) wants is open question 2 here.
- `crash-detail-pages.md`: a detail page should link to its road page.
- `keyboard-nav-and-speed-dial.md`: omnibar road category.

## Postscript: the DOT dashboard

Worth reporting upstream — Andrew hit a genuine usability failure, not user
error: the dashboard offers a street-name filter with no indication that the
street's crashes are filed under a route number, so a plausible-looking filter
silently returns ~8% of the corridor with no warning. That he recovered doesn't
make it a non-bug; it means the failure mode is *silent* and only caught by
someone with the domain knowledge to smell a wrong number. Ryan offered
in-thread to share maintainer contacts (`DOT-BTDS.DashboardSupport@dot.nj.gov`)
so they hear it from someone besides him. The 200-vs-5,586 discrepancy —
where both numbers came out of the same dashboard — is a concrete, reproducible
bug report.
