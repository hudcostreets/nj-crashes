# Harmonize NJSP and NJDOT fatal crashes

## Status (2026-04-15)

- **Core matcher landed** (`54984e2ebf9`). `njsp/match_njdot.py` implements passes 1-4; CLI at `njsp match_njdot`; dvc stage at `njsp/data/njsp_njdot_match.parquet.dvc`; unit tests at `njsp/tests/test_match_njdot.py`.
- Current coverage on 2008-2023: **8323 pairs (92.8% NJSP, 89.1% NJDOT-fatal)**. Residuals: 650 NJSP-only, 1021 NJDOT-only.
- Pass breakdown: 8128 (exact date,cc,mc) + 163 (cross-mc route+mp) + 16 (cross-county) + 16 (date±1).

Remaining work:
- **Richer residual categorization** — ✅ done (`91c5c71650e`). Split into `pd_missing`, `route_mismatch`, `unresolved`.
- **Per-pass observability** — one `njsp_njdot_match.parquet` today; consider emitting per-pass files or a `/harmonization` debug page.
- **Downstream consumers** — the matches aren't used yet. Obvious candidates: `crash-homicide.csv` gains a "reconciled" source (union of matched + NJSP-only + NJDOT-only); crash-detail pages (when built) can link to the NJDOT counterpart.
- **Crowdsourced pairing UI** — see `specs/crowdsourced-edits.md`.

## Pipeline-cadence modeling (annual vs daily)

NJSP data updates daily; NJDOT data updates annually and currently ends at 2023. The matcher's logical scope is the intersection: years where both sources fully cover. So:

- **Correct behavior**: matcher re-runs when NJDOT data (or pre-NJDOT-end NJSP rows) change. NOT when NJSP adds a new 2026 crash — those are out of NJDOT's range, can't be matched.
- **Current behavior**: `match_njdot.dvc` lists `crashes.parquet` (NJSP, full) as a dep. Any NJSP row update invalidates the stage. `dvx status` would flag it stale daily after each NJSP refresh, creating noise.

**Proposed fix**: introduce an intermediate stage `njsp/data/crashes_pre_njdot_end.parquet` (name TBD) that filters `crashes.parquet` to `year <= NJDOT_END_YEAR`. Key property: **its md5 is stable when pre-2024 NJSP rows don't change**, even if crashes.parquet gets new 2024+ rows. The matcher depends on this filtered parquet + `njdot/data/crashes.parquet`, so it only invalidates when either changes *in a way that affects the match*.

Stages:

```
  njsp/data/crashes.parquet ──► crashes_pre_njdot_end.parquet ──┐
                                                                 ├──► njsp_njdot_match.parquet
  njdot/data/crashes.parquet ─────────────────────────────────── ┘
```

Daily refresh adds a 2026 NJSP crash → `crashes.parquet` md5 changes → filter stage re-runs → filtered parquet md5 **unchanged** (no new pre-2024 rows) → matcher dep is fresh → matcher doesn't re-run. Waste: re-reading crashes.parquet and filtering (~1s). Acceptable.

Annual NJDOT refresh → NJDOT `crashes.parquet` changes → matcher re-runs. Expected.

Pre-2024 NJSP correction (e.g., re-harmonized via `njsp harmonize_muni_codes`) → filtered parquet changes → matcher re-runs. Expected.

This generalizes to other "DOT-dependent" artifacts (future crash-detail pages, reconciled homicides CSV, etc.) — they'd all consume the filtered intermediate.

## Further match-recovery heuristics

Current: passes 1-4 recover ~93% of NJSP, ~89% of NJDOT-fatal. Residuals (on 2008-2023):

| side | pd_missing | route_mismatch | unresolved |
|------|-----------|----------------|-----------|
| njdot | 803 | 74 | 144 |
| njsp | 449 | 74 | 127 |

`pd_missing` (1252) are genuine data gaps — one side records a crash the other doesn't. Not recoverable via better matching. **Recovery ceiling is `route_mismatch + unresolved = 419 residuals.** At best we could reach ~95% coverage.

Heuristic ideas, ranked by likely yield-per-effort:

1. **Time-of-day pass**. Within same `(date, cc)`, pair NJSP and NJDOT rows where `dt` times are within ±3 hours AND `tk` matches. Catches `unresolved` residuals on side-streets (no route info) but same time. **Low effort, medium yield.**

2. **Victim-type breakdown**. Within same `(date, cc, tk)`, pair on matching `pk` (pedestrians killed) — the one per-type count both sources track (NJSP has dk/ok/pk/bk; NJDOT only has tk/pk). Disambiguates when multiple same-tk same-cc crashes exist. **Low effort, low-medium yield.**

3. **Street-name fuzzy match**. For `unresolved` + `route_mismatch` residuals, fuzzy-match NJSP's `street` / `location` text against NJDOT's `road` / `cross_street`. Use `rapidfuzz` token-set ratio with a 0.7+ threshold. **Medium effort, medium yield.**

4. **Route alias normalization**. For `route_mismatch`, expand route normalization: map "GSP" / "Garden State Parkway" → "444", "NJTP" / "Turnpike" → "95" + milepost offset, etc. Would catch cases like a crash reported as "US 1" on one side and "NJ 26" on the other (renumbered). **Medium effort, low yield** (small number of known aliases).

5. **Lat/lon proximity**. NJDOT has `olat`/`olon`; NJSP doesn't. Would need to geocode NJSP's `location` text via OSM / NJDOT gazetteer. **High effort, medium yield** (most highway crashes have MP-derivable locations already captured by pass 2).

6. **Contact agencies**. Once the matcher tops out, the `pd_missing` residuals become a concrete list to show NJSP/NJDOT for review. Not a "heuristic" but the endgame for the last few %.

Implementation order: pass 5 (time-of-day) + pass 6 (victim-type) first since they're cheap. Then evaluate: if `unresolved` shrinks meaningfully, proceed to fuzzy-street. If most residuals end up as `pd_missing`, we're at the ceiling for heuristics and the remaining work is coordination with the source agencies.

## Motivation

The two sources for NJ fatal crashes disagree on year-level totals by
1-15% every year:

| year | NJSP deaths | NJDOT deaths | Δ |
|------|-------------|--------------|---|
| 2015 | 562 | 588 | -26 |
| 2017 | 624 | 684 | -60 |
| 2018 | 563 | 622 | -59 |
| 2023 | 606 | 604 | +2 |

Same counties, same period, different counts. `HomicidesComparisonPlot`
exposes this via the NJSP/DOT toggle, but we have no reconciled
per-crash view: we can't tell a user "how many total fatal crashes
actually happened in 2017" with confidence, and we can't link an NJSP
record to its NJDOT counterpart to enrich it with severity-level,
vehicle, driver, occupant, and pedestrian details.

## What's already known

A past attempt at reconciling these ran into messy alignment — street
names were similar but not exact, dates sometimes off by a day, muni
codes disagreed on interstate crashes, etc. Since then we have:

- **NJSP 2001-2026** from harmonized XML+PDF (see
  `specs/done/njsp-pdf-xml-harmonization.md` and `njsp-pre-2008-crashes`)
- **NJDOT 2001-2023** with geocoded `(cc, mc)` plus `(cc0, mc0)`
  originals — so muni ambiguity can be resolved both ways
- Clean `location`/`street`/`highway` on NJSP side; structured
  `route`/`mp`/`road`/`cross_street` on NJDOT side

## Preliminary findings (2026-04-12)

Match rates for **2008-2023** (years both sources cover well):

| Pass | Key | NJSP matched | NJDOT matched | Notes |
|------|-----|-------------|--------------|-------|
| 1 | exact `(date, cc, mc)` | 8218 / 8973 (92%) | 8259 / 9344 (88%) | many-to-many |
| 2 | `(date, cc, route)` on pass-1 residual | +144 pairs | +144 pairs | muni disagreement on same-route crash |
| 3+ | MP / name / ±1 day | ??? | ??? | open |

Unmatched after pass 1: **755 NJSP-only, 1085 NJDOT-only** (2008-2023).

Spot-checked pass-2 matches are all clearly the same crash:

| date | NJSP (cc,mc) | NJDOT (cc,mc) | location hint |
|------|-------------|--------------|---------------|
| 2015-01-08 | (15,13) Lakewood | (15,6) Brick | OCEAN COUNTY 618 MP 1.5 ↔ MP 2.0 |
| 2015-03-26 | (14,8) Rockaway | (14,35) Wharton | I-80 MP 37.3 ↔ MP 37.7 |
| 2015-04-22 | (17,11) Elsinboro | (17,14) Lower Alloways Creek | US 40 MP 24 |
| 2015-12-23 | (13,32) Wall | (13,1) Aberdeen | GSP MP 120.2 |

These are interstate/highway crashes where the two agencies assign
different municipality codes. **MP + route is the strongest signal.**

### Genuinely missing data

Some residuals are not alignment failures but real gaps. Example:
**Palisades Interstate Parkway Police stopped filing NJDOT reports
2013-2018** — Route 445 went from 134 crashes/year in 2012 to 1/year
in 2013-2018, then 230/year from 2019. NJSP still recorded fatal
crashes there. The Alpine (Bergen) muni plot visibly dips 2013-2018
as a result — see http://localhost:4006/c/bergen/alpine.

## Plan

### 1. Field normalization

Build side-by-side normalized views of NJSP and NJDOT fatal crashes:

- **date**: `dt.dt.date`
- **cc, mc**: canonical muni codes (NJDOT's `cc0/mc0` for the original
  reporting assignment plus `cc/mc` for the geocoded one; NJSP is
  authoritative for the geocoded assignment per
  `specs/done/njsp-pdf-xml-harmonization.md`)
- **route**: number parsed from NJSP `highway` and NJDOT `route`,
  normalized (strip `.0`, strip leading zeros, map "US 22"/"NJ 22"/"22"
  to `22`, map "I-80" to `80`, map "GSP" to `444`, "ATL CITY EXPWY"
  to `446`, etc.)
- **mp**: milepost. NJDOT has it directly; NJSP has it embedded in
  `location` text (`"State Highway 70 E MP 55.22"` → `55.22`). Regex
  `\bMP\s*(\d+(?:\.\d+)?)` recovers it from ~57% of NJSP rows (8519
  / 14899).
- **street**: NJSP `street`; NJDOT `road` (often "BURLINGTON COUNTY
  604") and `cross_street`. Normalize to drop prefixes like "STATE
  HIGHWAY", "COUNTY", the county name.
- **tk**: total killed (both sides have this).

### 2. Multi-pass greedy matcher

Adapt the approach from `njsp/harmonize_pdfs.py` (several passes,
claimed-index tracking, tk-sum consistency checks):

1. **Exact `(date, cc, mc)`** with equal row count and equal tk sum.
2. **Same `(date, cc)`, different mc** — accept when `(route, mp)` also
   agrees (within tolerance, e.g. |Δmp| ≤ 1.0 mi).
3. **Same `(date)` across counties** with route+mp agreement (catches
   interstate crashes assigned to the wrong county).
4. **Date ±1 day** with route+mp agreement (covers midnight crashes
   reported on different days).
5. **Street-name fuzzy match** (Jaro-Winkler or token-set ratio) within
   same `(date, cc, mc)`, when route isn't available.

Each pass operates only on the unclaimed residual from earlier passes
to avoid double-matching.

### 2a. Per-pass observability

Each pass should emit its matched pairs to a separate table so we can
browse, debug, and build trust in the matcher:

- `crash_match_pass1.parquet`, `crash_match_pass2.parquet`, etc.
- Schema: `njsp_id`, `njdot_pk (year,cc,mc,case)`, match keys used,
  any tolerances applied, `tk_njsp`, `tk_njdot`.
- A single unified `crash_matches.parquet` concatenates them with a
  `pass` column.

Site surface (optional but valuable): a `/harmonization` debug page
that lets us filter by pass, year, county, match key. Users can
click through to NJSP crash detail (via `specs/crash-detail-pages.md`)
to verify manually. This becomes a permanent artifact for "how do we
know these are really the same crash" — and the `residuals` table
becomes a public list of "known reconciliation gaps" that readers
can contribute context to (see `specs/page-annotations.md`).

### 2b. Crowdsourced residual reconciliation

In the limit the matcher degrades to a side-by-side web interface
showing **NJSP-only rows on the left**, **NJDOT-only rows on the
right** (filterable by year/county), where a reader can:

- Click two rows to propose "these are the same crash" — optionally
  with a free-text note explaining why (e.g. "news article confirms
  this was an Interstate 80 crash in Wharton, not Rockaway").
- Submit the pairing to a moderation queue (Slack review — see
  `specs/crowdsourced-edits.md`).
- See the accumulated community-verified pairings as a fifth match
  "pass" (`crash_match_pass5_community.parquet`) that layers on top
  of the algorithmic ones.

This turns an otherwise-impossible manual cleanup task into something
that scales with reader interest — especially for the PIPW/Palisades
2013-2018 era and other known-bad windows where a local who remembers
a specific fatal crash can confirm it in seconds.

### 3. Residuals report

Emit a `crash_match_residuals.parquet` listing unmatched rows from
each side, categorized by suspected reason:

- `pd_missing`: NJDOT has no same-date crash in the county (e.g.
  Palisades 2013-2018)
- `ns_missing`: NJSP has no same-date crash (we should always match
  here since NJSP's rule is "every fatal crash")
- `route_mismatch`: both have date+cc but routes disagree
- `unresolved`: no signal

### 4. Output

Write `njsp_njdot_crash_match.parquet` at project root (or
`njsp/data/`) keyed by NJSP crash id with columns for the matched
NJDOT `(year, cc, mc, case)` PK. Downstream:

- Crash-detail pages (see `specs/crash-detail-pages.md`) can link
  NJSP records to NJDOT severity/vehicle/occupant data
- `crash-homicide.csv` can add a "reconciled" source that reports
  the union (or the NJSP value for matched rows, NJDOT value for
  NJDOT-only rows) — finally giving an authoritative annual total
- Plot subtitles / `HomicidesComparisonPlot` buttons can expose
  match quality as a tooltip or footnote

### 5. Validation

- Every **matched** pair should agree on tk (or flag as a
  discrepancy for manual review)
- Total **unmatched NJSP** should decrease with each pass; hand-review
  the final unresolved residuals
- Cross-check: the count of matched-both + matched-NJSP-only +
  matched-NJDOT-only ≈ union of both sources

## Open questions

- What's the authoritative source when the two disagree on `tk`?
  (In practice, both are ≥99% reliable per their own workflows; we'd
  keep both and expose the delta.)
- Should we surface match confidence on per-crash detail pages?
- Is it worth investigating / documenting the Palisades Interstate
  Parkway reporting gap upstream (email NJDOT)? — Relevant to the
  broader data-quality story.

## Out of scope

- Aligning NJSP/NJDOT **injury** crashes (NJSP only records fatal;
  NJDOT has injury+property-damage too). This is fatal-only.
- Per-vehicle / per-occupant harmonization — needs the crash-level
  match first.
- Backfilling NJSP records for Palisades IPW 2013-2018 into NJDOT
  (would need the DOT source dataset; out of our hands).
