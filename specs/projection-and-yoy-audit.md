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

### Phase 1.5: Replace the git walk with a `crash-log.parquet` query
- Prototype reconstructing `prv_ytd_total` / `prv_ytd_crashes` from
  `crash-log.parquet` event replay (`rundate ≤ {prv_year}-MM-DD`).
- Cross-check against `oldest_commit_rundate_since` output for a range
  of dates; only swap once byte-equal (or document the discrepancy).
- Keeps `Ytd` off git entirely → faster `projections.dvc`, no shallow-
  clone GitHub-API fallback needed.

### Phase 2: Replace Jan-1-anchored projection with 365d-lookback
- `update_projections` should compute "projected total for next
  365 days" from the trailing 365d, instead of "projected total for
  current calendar year".
- Or split: keep the calendar-year projection (still useful Aug-Dec)
  but add a new trailing-365d metric that's always meaningful.

### Phase 3: New YTD plot mode — 1yr-lookbacks-by-end-date
- Existing `YtdDeathsPlot` shows cumulative deaths from each
  Jan 1 to the present day.
- New mode: cumulative deaths over the 365 days **ending on the
  current date**, plotted across multiple years. Each year's line
  represents "the year ending on April 14 of year X."
- Question this answers: **how deadly was the last ~365d compared
  to historical 365d windows?** That's the sensible "how are we
  doing" framing.
- UI: add a third option to the YTD plot's view-mode toggle
  (currently `ytd | full-faded | full`) — call it `trailing-365`
  or `1yr-rolling`.

## Open questions

- Does the trailing-365 view need a different x-axis? Could use
  "days from window-end" (going backwards), or just calendar dates
  spanning Apr 14 prev → Apr 14 cur.
- For UI: keep view-mode toggle linear (4 options) or split into
  two axes (anchor: `Jan 1` vs `current date`; window: `to-date`
  vs `full year`).
- The git-log walking pattern probably also affects
  `slack_post.sh` lookback (see `specs/slack-sync-lookback.md`) —
  align both.

## Out of scope
- Changing the projection algorithm itself (Bayesian update, etc.) —
  just changing the *anchor*.
- Backfilling pre-2001 data for longer YoY comparisons.
