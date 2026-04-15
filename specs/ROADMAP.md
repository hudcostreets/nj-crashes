# Roadmap

Living doc capturing relative priority across open specs. Update as
priorities shift; treat as a default ordering, not a contract.

## Active sequence (2026-04-14)

User-confirmed ordering:

1. **`dvx-external-https-deps.md`** — *in progress*. Adopt
   `dvx import-url --git` for NJSP XML / PDF fetching. Internal
   plumbing; user-invisible but cleans up custom Python fetch
   logic in `refresh_data` / `refresh_summaries`.
2. **`njsp-njdot-fatal-harmonization.md`** — multi-pass matcher
   between NJSP and NJDOT fatal crashes. Foundational for
   crash-detail enrichment + reconciled annual totals.
3. **`county-maps-and-og-images.md`** — generalize the
   Hudson-only Leaflet map to all counties + munis + statewide.
   Big visual gap.
4. **`crash-detail-pages.md`** — per-crash pages aggregating NJSP
   + NJDOT + news links + Bluesky thread embed + Slack
   `#crashdashbot` backfill.

Annotations explicitly deprioritized — they only surface on
random sub-pages most users won't encounter.

## Other queued work

- `slack-sync-lookback.md` — small win, but coordinate with
  `projection-and-yoy-audit.md`'s broader git-log-walking audit
- `slack-channel-client-cleanup.md` — defensive parsing, fixtures,
  tests; NaN-on-int fix was one symptom, more bugs likely lurking
- `projection-and-yoy-audit.md` — audit git-log-walking, replace
  Jan-1-anchored projection with 365d-lookback, add trailing-365
  YTD mode
- `crashplot-facet-by-police-dept.md` — link target for Alpine
  annotation; nice-to-have
- `omnibar-navigation.md` — Cmd+K nav via `use-kbd`
- `crowdsourced-edits.md` — auth + Slack review queue for
  user-submitted edits

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
