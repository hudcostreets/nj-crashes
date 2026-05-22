# Projection + YoY model audit; 1-year-lookback YTD plot

## Motivation

Two related concerns:

1. **YoY data fetch is hacky.** We currently fetch ~1yr of previous
   commits to compute year-over-year info (where? — `update_projections`
   + maybe `crash-log` walking). This grew organically, never
   audited end-to-end.

2. **Projection model is anchored to Jan 1.** "Year-to-date deaths +
   projected rest-of-year" is meaningful in late summer/fall, but
   in January it's pure noise — extrapolating 30 days into a full
   year produces wild error bars. The same model should look back
   **365 days** rather than to the most-recent Jan 1.

## Phase 1 audit findings (2026-05-21)

Grepped every `iter_commits` / `Repo()` / `blob_from_commit` /
`repo.commit` call site under `njsp/` + `nj_crashes/`. Only **two**
code paths actually walk commit history; one is the hacky one, the
other is fine.

### 1. `oldest_commit_rundate_since()` — `njsp/ytd.py:51` — **the hacky one**

Walks **all** commits backward from `HEAD`, JSON-deserializing
`rundate.json` out of every commit's tree, until it finds the oldest
commit whose `rundate ≥ {prv_year}-{cur_month}-{cur_day}`. Reached via
`Ytd.prv_commit_rundate → prv_commit → prv_ytd_fauqstats`, which then
reads `FAUQStats{prv_year}.xml` **as it stood ~365 days ago** to get
`prv_ytd_total` (the YTD fatality count NJSP had *reported* at the same
calendar point last year) and `prv_ytd_crashes`.

- **Why it needs historical state:** NJSP revises crash records
  continuously (the whole point of `crash-log.parquet`). "How many
  deaths had NJSP reported as of May 21 *last* year" is a point-in-time
  question the current `crashes.parquet` (latest state only) cannot
  answer.
- **Cost:** unbounded — one blob deserialization per commit, from
  `HEAD` back ~1 year of daily commits (≈300+). Runs every
  `update_projections` (daily stage `projections.dvc`).
- **Can it be a static query?** *Yes, in principle* — `crash-log.parquet`
  **is** the historical add/update/del event log keyed by `rundate`,
  already produced daily as a static artifact. `prv_ytd_total` could be
  reconstructed by replaying events with `rundate ≤ D`. This is
  correctness-sensitive (add→update→del sequencing must reproduce
  `FAUQStats.totals.fatalities` exactly) — warrants a prototype +
  cross-check against the git-walk result before adopting. Logged as
  **Phase 1.5** below.

### 2. `get_crash_log()` — `njsp/crash_log.py:72` — **fine, incremental**

Walks history computing per-commit add/update/del crash events, but
`crash_log compute -a <pqt>` (daily `crash-log.parquet.dvc` stage)
starts the walk at the **latest SHA already in the parquet** and only
processes new commits — bounded, ~1 commit/day. Falls back to the
GitHub API for commit traversal when the local clone is shallow.
No change needed.

### Not walkers (checked, cleared)

- `CommitCrashes` (`commit_crashes.py`) — per-commit diff helper used
  *by* `get_crash_log`; single-commit.
- `Crashes(ref=…)` (`crashes.py:102`) — single `repo.commit()` blob
  read for XML-diff-URL generation in `crash/log.py`.
- `refresh_data.py` — `git add`s fetched XML; reads `rundate` straight
  from XML content, no history walk.
- `bsky/post.py`, `slack/sync.py` — consume `crash-log.parquet`; no walk.

### Verdict

The spec's premise ("YoY fetch walks ~1yr of commits") is real but
**localized to exactly one function**, `oldest_commit_rundate_since`.
`bsky/backfill.py` (named as a suspect in the original spec) does not
exist / does not walk. Phase 2/3 below are independent of this cleanup.

## Proposed work

### Phase 1.5: Replace the git walk with a `crash-log.parquet` query ✅

Done (2026-05-21). `njsp.crash_log.feed_snapshot(year, as_of)` replays
`crash-log.parquet` add/update/del events to reconstruct the NJSP feed's
point-in-time view of a year — the prev-year snapshot `update_projections`
needs. `Ytd` now calls it (`prv_feed_snapshot`); `oldest_commit_rundate_since`
+ the `prv_commit` / `prv_ytd_fauqstats` chain are deleted. `Ytd` no longer
touches git.

Cross-checked against the old git-walk for 11 `(year, MM-DD)` targets
spanning 2023–2025: `to_ytc` / `to_ytmc` byte-identical every time, and
`prv_ytd_total` (`sum(FATALITIES)`) equals the old XML `<TOTFATALITIES>`.
`update_projections` produces a byte-identical `projected.csv`. Frozen
golden + synthetic-replay tests in `njsp/tests/test_feed_snapshot.py`.

Note (informs Phase 2): the walk was clunky in *mechanism* but sound in
*purpose* — it corrects NJSP **reporting lag**. This year's `cur_ytd` feed
under-counts recent un-entered crashes, so the model compares it against
last year's *equally-incomplete* feed snapshot at the same calendar point;
the ratio cancels the lag bias. Any reframe in Phase 2/3 must preserve
that — a plain `crashes.parquet` occurrence-date filter would bias it.

### Phase 3: New YTD plot mode — trailing-365 ✅

Done (2026-05-21). `YtdDeathsPlot` gains a 4th view-mode toggle button,
`Trailing` — per year, the cumulative-deaths curve over the 365 days
**ending on today's date**. Unlike YTD (which compares partial Jan-1
slices), every line is a complete, comparable 365-day window. Answers
"how deadly was the last ~365d vs historical 365d windows?".

x-axis: calendar dates spanning the window (Jun→Dec→Jan→May, month
labels) — the user-picked option. Frontend-only: the windowing
(`trailing365Series`) is computed from the existing `ytd.parquet` daily
fatalities, no backend change. Pure module `www/src/njsp/trailing365.ts`
+ unit tests `trailing365.test.ts`.

### Phase 2: Replace Jan-1-anchored projection with 365d-lookback (still open)
- See the Phase 1.5 note: the current model already *damps* the
  January signal via `cur_ytd_frac`, so it's not "wild error bars" —
  it's *low-information* in January (the headline ≈ last year's total).
- The Phase 3 trailing-365 *plot* now gives the always-meaningful view;
  Phase 2 would additionally surface a trailing-365 *projected number*
  alongside (or instead of) the calendar-year "on pace for N".
- Any reframe must preserve the reporting-lag correction (Phase 1.5).

## Open questions

- ~~trailing-365 x-axis~~ — resolved: calendar dates spanning the window.
- ~~toggle linear vs 2-axis~~ — resolved: 4th linear toggle button.
- The git-log walking pattern probably also affects
  `slack_post.sh` lookback (see `specs/slack-sync-lookback.md`) —
  align both.

## Out of scope
- Changing the projection algorithm itself (Bayesian update, etc.) —
  just changing the *anchor*.
- Backfilling pre-2001 data for longer YoY comparisons.
