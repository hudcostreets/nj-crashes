# Per-capita crash statistics

## Motivation

Absolute crash and fatality counts conflate two signals: how dangerous a place is and how many people live there. A toggle to "per 100k population" on existing plots would let users compare counties and munis on equal footing (e.g. Newark vs. small Bergen towns), and reveal real per-capita trends over time.

Plots in scope:
- `www/src/njsp/FatalitiesPerYearPlot.tsx` ("Car Crash Deaths") — primary
- `www/src/njsp/HomicidesComparisonPlot.tsx` (per-capita axis useful here too)
- `www/src/njdot/CrashPlot.tsx` ("NJ DOT Crash Data")
- `www/src/njsp/YtdDeathsPlot.tsx` (eventually; YTD-per-100k is a stretch)

Out of scope: per-driver, per-VMT (FHWA), per-registered-vehicle.

## ACS coverage details

### 1-year vs 5-year (NJ specifics)

| Estimate | Threshold | Vintage cadence | NJ coverage |
|---|---|---|---|
| ACS 1-year | population ≥ 65,000 | annual (2005–) | All 21 NJ counties; ~28 munis (out of 564); the state |
| ACS 5-year | none (all places) | annual rolling 5-yr (2005-09 release on, vintage = end year) | All counties + all 564 munis |
| ACS 1-yr Supplemental | ≥ 20,000 | 2014– | wider muni coverage but limited variables |

**Decision: use ACS 5-year for everything.** Reasons:
1. Uniform coverage (all 564 munis) — no gaps, no per-muni branching logic.
2. The 1-year series for the ~28 NJ munis ≥ 65k would be more "current" but the gain is marginal for a denominator that changes ≤ 2%/yr.
3. We avoid the "is this town big enough this year?" code path. Population is a slow signal; the smoothing is fine.
4. The user's intuition (1-yr where available, 5-yr elsewhere) is technically correct but adds complexity for ≈no analytic value here. **Flagging this for review** — the user may want 1-yr at the state level just so 2024 data shows up promptly. Easy follow-up if so (state-level only, single API call/year).

ACS 5-year vintages run from `2005-2009` through (currently) `2019-2023`. Each vintage's "year" is the **end year**. We index our `population.parquet` by end year.

### 2001–2008 (pre-ACS)

ACS 5-year starts with the `2005–2009` vintage (year=2009). For 2001–2008 we interpolate between Census decennial counts:

| Year | Source |
|---|---|
| 2000 | Decennial 2000 SF1 P001 (total pop) |
| 2001–2008 | linear interpolation between 2000 and 2010 anchors |
| 2009 | ACS 5-year `2005–2009` |
| 2010+ | ACS 5-year, end-year vintage |

We could refine 2001–2008 by including the 2010 decennial as a second anchor (between-decennial linear interpolation), but ACS 2009 is so close to decennial 2010 that it's redundant. **Simpler approach: linear interpolate `(year, pop)` from `(2000, pop2000)` to `(2009, pop_acs2009)`.** Adopt this unless someone asks for more precision.

Boundary changes: most NJ munis are stable 2000→present, but a few aren't (Princeton 2013 merger, Pine Valley 2022 dissolution into Pine Hill). Handle with the same `mn_fixes` table already in `harmonize-muni-codes.ipynb` — pre-merger entities collapse to the post-merger Census Place. Document in the script.

## Data sources + variables

| Variable | Code | Use |
|---|---|---|
| Total population | `B01003_001E` | primary denominator |
| Median age | `B01002_001E` | optional, future |
| Pop 16+ | `B23001_001E`-ish (driver-age proxy) | optional, future — exact code TBD |

**MVP: just `B01003_001E`.** Driver-age denominator is a possible follow-up but most casualties (passengers, peds, cyclists) aren't drivers, so total population is the more general normalizer.

### API endpoints

ACS 5-year:
```
https://api.census.gov/data/{year}/acs/acs5?get=NAME,B01003_001E&for=state:34
https://api.census.gov/data/{year}/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:34
https://api.census.gov/data/{year}/acs/acs5?get=NAME,B01003_001E&for=county+subdivision:*&in=state:34+county:*
```

Decennial 2000 SF1:
```
https://api.census.gov/data/2000/dec/sf1?get=NAME,P001001&for=county+subdivision:*&in=state:34+county:*
```

**Geo level: `county subdivision`, not `place`.** This is the critical NJ-specific decision (see GEOID harmonization below).

### Auth & rate limits

- Free API key: register at <https://api.census.gov/data/key_signup.html>. Without a key, requests > 500/day from one IP are blocked. With one, no published rate limit but we're well under any reasonable cap (≤ 25 calls/year × ~20 vintages = a few hundred requests one-time).
- Store key in `.env` as `CENSUS_API_KEY`, gitignored.
- Library: `requests` + a tiny cache (write JSON responses under `tmp/census/{vintage}_{geo}.json`). `cenpy` is fine but adds a dep with a sometimes-lagging variable database; raw `requests` is ~30 lines.

## Pipeline

New module: `census/` (sibling of `njsp/`, `njdot/`).

```
census/
  __init__.py
  fetch.py          # Census API client + caching
  build.py          # parquet assembly: API JSON → tidy parquet
  harmonize.py      # NJ subdivision GEOID → (cc, mc) join
  data/
    population.parquet           # final tidy output
    population.parquet.dvc
    raw/                         # cached API responses (DVX-tracked? probably not; idempotent re-fetch)
      acs5_2009_county.json
      acs5_2009_cousub.json
      ...
      dec2000_cousub.json
```

### `population.parquet` schema

| col | type | example |
|---|---|---|
| `year` | int16 | 2015 |
| `level` | category | `state` / `county` / `muni` |
| `cc` | int8 (nullable for state) | 7 |
| `mc` | int8 (nullable for state and county) | 38 |
| `population` | int32 | 277540 |
| `source` | category | `acs5` / `dec2000` / `interp` |

Long format. ~25 years × (1 state + 21 counties + 564 munis) ≈ 14.6k rows. Trivially small.

### DVX stage

```yaml
# census/data/population.parquet.dvc
outs:
  - md5: ...
    path: population.parquet
meta:
  computation:
    cmd: python -m census.build
    deps:
      /njdot/data/cm.pqt: ...           # for cc/mc → name lookups
      census/harmonize.py: ...
      census/build.py: ...
      census/fetch.py: ...
```

The cached API responses (`census/data/raw/`) are not deps — `build.py` re-fetches if missing, otherwise uses cache. Run `python -m census.fetch --refresh` to force-refresh.

### Daily pipeline

Population data updates ~once/year (when a new ACS 5-yr vintage drops, mid-December). **Not part of the daily DVC chain.** Run manually when a new ACS vintage releases, similar to `njsp_njdot_match.parquet.dvc` cadence (see `specs/njsp-njdot-fatal-harmonization.md`).

## GEOID harmonization (the hard part)

### Why this is non-trivial

NJ is unusual: every square inch of NJ is in some incorporated municipality (no unincorporated land). Census models this with **county subdivisions** (`cousub`), not **places**. A `cousub` GEOID is `34{cc_fips}{mc_fips}` (10 digits: 2-state, 3-county, 5-cousub).

| System | Format | Example (Newark) |
|---|---|---|
| NJDOT | `(cc, mc)` int pair | `(07, 8)` |
| NJSP | different `(cc, mc)` | `(07, 9)` (or whatever) |
| NJGIN | `(cc, mc)` | canonical |
| Census `cousub` | `34{cnty_fips}{cousub_fips}` | `3401351000` |
| Census `place` | `34{place_fips}` | `3451000` |

NJDOT/NJSP/NJGIN use 1–2 digit muni codes per county. Census `cousub` codes are 5-digit FIPS, totally different namespace. There's no formula — we need a lookup table.

### Approach: convert `harmonize-muni-codes.ipynb` → `.py`, then extend

The existing notebook (~30 cells, mostly procedural code with a few markdown headers) is the natural place to add Census GEOID alignment, but since we're touching it substantially anyway and the user has explicitly said the `.ipynb` causes occasional rebase conflicts and is rarely re-run interactively, **convert it to `njdot/harmonize_muni_codes.py` (or `njdot/cli/harmonize_muni_codes.py` if there are CLI ergonomics) as part of this work.** Bulleted plan:

1. **Convert.** `jupyter nbconvert --to script` then hand-clean: drop ipynb-only `display`/return-cell behaviors, collapse redundant `df` previews, keep error-print sites (`err(...)`). Reorder so it runs top-to-bottom as a script. Module-level docstring summarizing the pipeline.
2. **Add a fourth source ("cen" or "fips")** alongside `dot`/`sp`/`gin`. Load the [TIGER/Line 2023 county subdivision shapefile for NJ](https://www2.census.gov/geo/tiger/TIGER2023/COUSUB/tl_2023_34_cousub.zip) once, extract `(GEOID, NAMELSAD, COUNTYFP, COUSUBFP)`. NJ has 565 cousubs (564 munis + 1 "county subdivisions not defined" placeholder we drop).
3. **Build `cousub_name → (cc, mc)` map.** Reuse the existing stem/type normalizer (`add_stems`, `align`) — Census uses "City of Orange Township" / "Newark city" / "Princeton" / etc. Same Title Case + suffix conventions, with a fixes table.
4. **Persist.** Add `cousub_geoid` (string, 10-digit) column to `nj_crashes/data/county_city_codes.parquet` (`COUNTY_CITY_CODES_PQT` / `cm.pqt`). Or write `census/data/nj_cousub_codes.parquet` with `(cc, mc, cousub_geoid, cousub_name)`.
5. **Validate.** Assert all 564 munis (= 565 minus the placeholder) get a GEOID. Manually fix the few that fall through (~5–10 expected — Princeton-merger artifacts, "City of Orange Township" full-name oddities, etc.).
6. **Update DVX.** The current `.dvc` (if any) cmd that runs the notebook (e.g. via `juq papermill`) becomes a `python …harmonize_muni_codes.py` invocation. Delete the `.ipynb` from git when the new `.py` lands; CLAUDE.md's "Key Files" reference updated in the same commit.

### Known tricky cases

| NJDOT name | Census cousub | Note |
|---|---|---|
| Princeton | `Princeton` | post-2013 merger; pre-2013 NJDOT rows use Princeton Twp + Princeton Boro, both → post-merger Census GEOID |
| Orange Twp | `City of Orange township` | full Census name |
| Pine Valley Boro | merged into Pine Hill Boro 2022 | pre-2022 Census still has Pine Valley as separate GEOID |
| Pahaquarry Twp | merged into Hardwick Twp 1997 | not in Census 2000+; project already maps to Hardwick |
| Port Authority (cc=99) | n/a | no Census denominator; per-capita undefined for these crashes — skip |

The Princeton-merger handling means: **for years < 2013, `population` for `(cc=11, mc=Princeton)` should be the sum of pre-merger Borough + Township populations.** Same kind of logic for Pine Valley/Pine Hill in 2022. Encode as a small "merger map" in `census/harmonize.py`.

### Don't reach for `place`

NJ "places" exist in Census but are inconsistent (some munis are also places, some aren't, some places span multiple munis). `cousub` is the right level. Skip the `place` API entirely.

## Frontend integration

### Toggle

Add an "absolute / per 100k" toggle to the four plots above. Two reasonable spots:
- A button in each plot's `ControlsGear` (consistent with existing per-plot controls)
- A page-global toggle in `Home.tsx` next to the geo filter (simpler, applies everywhere)

**Recommend: per-plot in `ControlsGear`.** Some plots (raw count comparisons, e.g. fatalities-by-month) don't benefit from per-capita and the toggle is plot-specific. Aligns with how `YtdDeathsPlot`'s settings gear already works.

Default: **absolute**. Toggling to per-capita scales y-values by `1e5 / population[year, geo]`.

### Data plumbing

- Bundle `population.parquet` (or a CSV/JSON derivative) into `www/public/`. Tiny file (~150KB).
- Frontend hook `usePopulation(cc, mc, year)` reading from a new `www/src/usePopulation.ts`. TanStack-Query-cached parquet fetch (parallel to existing parquet hooks).
- For statewide and county levels, population is always defined. For muni level, always defined post-2000 (we have full coverage via ACS 5-yr + 2000 decennial + interpolation).

### Edge cases

- **Division by zero**: not possible if we always populate from real sources (lowest NJ muni pop is ~70 — Walpack Twp).
- **Pre-2001 / future years**: clip to range. For projected year-end (existing feature), use the most-recent population.
- **Per-capita on a YTD plot**: `cumulative_deaths(d) / pop * 1e5` — meaningful but rare. Defer.
- **Per-capita on a stacked plot** (FatalitiesPerYearPlot stacked by victim type): fine — divide each stack value by the same denominator, stacks still sum correctly.
- **Rates of small munis**: 2 deaths / 5000 pop = 40 per 100k, headline-grabbing but noisy. Add a tooltip caveat or a "min population" filter for state-wide rankings (out of scope for v1).

### Units

Use **per 100,000 population** (standard for crash/fatality stats; matches CDC/NHTSA convention). Don't try "per 100k-yr" — annual rates already imply per-year.

## Pipeline diagram

```
Census API ─┐
            ├── census/fetch.py ── raw/*.json ──┐
TIGER cousub─┘                                   │
                                                 ├── census/build.py ── population.parquet
harmonize-muni-codes (cousub_geoid column) ──────┘                            │
                                                                              ▼
                                                                   www/public/population.parquet
                                                                              │
                                                                              ▼
                                                                   useCensusPop() in plots
```

## Open questions

1. **1-year ACS at state level only?** Trivial to add for promptness (state-level current-year denominator within ~9 months instead of ~21). Worth it?
2. **Pop denominator unit**: per 100k vs per 10k? 100k is convention but per 10k is more readable for small munis (where rates are small). Sticking with 100k unless feedback.
3. **Population deltas for plots**: should we expose population-as-a-line-on-its-own (e.g. for users who want to *see* the denominator)? Probably no — out of scope.
4. **Backfill earlier than 2000?** NJSP data goes to 2001 (and PDF backfill could push to earlier). Decennial 1990 + interp would cover 1990-1999. **Defer** — no current plot pre-2001.
5. **County boundary changes?** None in NJ since the 1838 creation of Mercer County. Safe.
6. **Margins of error**: ACS publishes MOE alongside estimates. For v1 we use point estimates only; MOE could be surfaced in tooltips later (probably not worth the visual noise).
7. **`harmonize-muni-codes.ipynb` → `.py` conversion**: bundled into this work since we're materially extending it. The notebook has caused rebase conflicts and is essentially never re-run interactively; converting once-and-done. Tradeoff: 30-cell notebook → ~300-line script; lose ipynb-cell preview ergonomics during one-off debugging but those were rarely used.

## Out of scope

- Demographic breakdowns (age × sex × race per-capita rates).
- VMT-based denominators (FHWA HPMS data, not Census).
- Per-vehicle / per-registered-driver rates (would need NJMVC data).
- Census tract / block group geography (crashes don't reliably geocode to tract; we have muni-level PKs only — but see `specs/done/map-pipeline-pdo-and-top-route.md` for tract-level future work).
- Adjusting NJSP fatal counts to match NJDOT (separate issue, see `specs/njsp-njdot-fatal-harmonization.md`).
