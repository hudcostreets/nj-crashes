# Roadmap

Living doc capturing relative priority across open specs. Update as
priorities shift; treat as a default ordering, not a contract.

## Now / next (small wins, contained scope)

1. **`dvx-external-https-deps.md`** — adopt `dvx import-url --git`
   for NJSP XML / PDF fetching; replaces custom Python fetch logic
   in `refresh_data` / `refresh_summaries`. Cleaner integration with
   the dvx pipeline we just standardized on.
2. **`slack-sync-lookback.md`** — replace the arbitrary 7-day window
   in `slack_post.sh` with smart "walk back to fully synced"
   logic. (Related: see `projection-and-yoy-audit.md` for the
   broader git-log-walking audit.)
3. **`page-annotations.md`** — phase 2: visually shade the affected
   year range on the plot itself (currently only icon trigger), add
   5-10 more confirmed entries from `tmp/gap-candidates.md`.

## Mid-term

4. **`njsp-njdot-fatal-harmonization.md`** — multi-pass matcher
   between NJSP and NJDOT fatal crashes. Foundational for
   crash-detail enrichment + reconciled annual totals.
5. **`slack-channel-client-cleanup.md`** — defensive parsing,
   per-crash `try/except`, fixtures + tests. The NaN-on-int fix was
   one symptom; more bugs likely lurking.
6. **`projection-and-yoy-audit.md`** — audit git-log-walking,
   replace Jan-1-anchored projection with 365d-lookback, add new
   trailing-365 mode to YTD plot.
7. **`crashplot-facet-by-police-dept.md`** — least important of
   the mid-term; nice link target for the Alpine annotation, but
   not blocking other work.

## Larger / multi-session

8. **`crash-detail-pages.md`** — *high user demand*. Per-crash
   pages aggregating NJSP + NJDOT + news links + Bluesky thread
   embed + Slack `#crashdashbot` backfill.
9. **`omnibar-navigation.md`** — Cmd+K nav to counties / munis /
   sections via `use-kbd`. Probably easier than expected.
10. **`county-maps-and-og-images.md`** — generalize the
    Hudson-only Leaflet map to all counties + munis + statewide.
    State / county / muni map coverage is a big visual gap.
11. **`crowdsourced-edits.md`** — auth + Slack review queue for
    user-submitted annotations / harmonization pairings / crash
    refs. Lowest priority of the longs.

## Other open specs (not yet ranked)

- `crash-log-fsck.md`
- `dvx-gc-ephemeral-artifacts.md`
- `dot-table-vehicle-stats.md`
- `keyboard-nav-and-speed-dial.md` (largely superseded by
  `omnibar-navigation.md`)
- `njdot-bubble-plot.md`
- `njdot-victim-vehicle-plots.md`
- `njsp-historical-pdf-parsing.md`
- `njsp-muni-level-data.md`
- `njsp-pdf-data-quality.md` (findings doc, not actionable)
- `primary-source-mirrors.md`

## Known bugs / cleanups (not specced)

- `wrangler.toml` had duplicate `STAGING_OCCUPANTS_DB` bindings →
  fixed via `d1-import.sh` trap (`c3ad03f39c2`). Watch for
  recurrence.
- D1-import flakes on CF API timeout (`Cancelled due to no poll()`
  late in run). Each retry is fresh staging (~hours). Could add
  a resume-from-last-chunk mode.

## Done recently

See `specs/done/` for completed work. Highlights from this session:
- Pre-2008 NJSP data extension (`done/njsp-pre-2008-crashes.md`)
- Annotations phase 1 (Alpine '13-'18)
- pltly fixes: solo-reset opacity leak + outside-click dismiss
- Slack `accid_thread` NaN-on-int fix
- Harmonize `.dvc` deps (unblocks GHA)
