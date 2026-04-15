# Projection + YoY model audit; 1-year-lookback YTD plot

## Motivation

Two related concerns:

1. **YoY data fetch is hacky.** We currently fetch ~1yr of previous
   commits to compute year-over-year info (where? — `update-projections`
   notebook + maybe `crash-log` walking). This grew organically, never
   audited end-to-end.

2. **Projection model is anchored to Jan 1.** "Year-to-date deaths +
   projected rest-of-year" is meaningful in late summer/fall, but
   in January it's pure noise — extrapolating 30 days into a full
   year produces wild error bars. The same model should look back
   **365 days** rather than to the most-recent Jan 1.

## Proposed work

### Phase 1: Audit
- Map every place we walk git history for crash-log / YoY data.
  Likely candidates: `update-projections.ipynb`, `crash_log.py`,
  `bsky/backfill.py`, anything reading "previous year" data.
- Document why each one needs historical state vs. just the current
  snapshot. Identify which can be replaced with a static query
  against `crashes.parquet`.

### Phase 2: Replace Jan-1-anchored projection with 365d-lookback
- `update-projections` notebook should compute "projected total
  for next 365 days" from the trailing 365d, instead of "projected
  total for current calendar year".
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
