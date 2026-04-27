# Roadmap

Living doc capturing relative priority across open specs. Update as
priorities shift; treat as a default ordering, not a contract.

## Active sequence (2026-04-27)

User-confirmed ordering. `e` and laptop work in parallel; nothing is
gating the other today.

### Backend (`e`)

1. **`dvx-external-https-deps.md`** — *in progress*. Adopt
   `dvx import-url --git` for NJSP XML / PDF fetching. Internal
   plumbing; user-invisible but cleans up custom Python fetch
   logic in `refresh_data` / `refresh_summaries`.
2. **`njsp-njdot-fatal-harmonization.md`** — multi-pass matcher
   between NJSP and NJDOT fatal crashes (currently ~93%
   coverage). Foundational for crash-detail enrichment +
   reconciled annual totals.
3. **Map v2 Phase 3 (BE half)** — drop v1 outputs from
   `map.dvc`; `map_sync.dvc` clears stale S3 keys via
   `aws s3 sync --delete`. Should land *after* the FE half
   deploys to CFP so no stale client hits 404s.

### Frontend (laptop)

1. ~~**Map v2 Phase 2 cleanup**~~ — done. Picker falls back to
   r6 single-file when shard count >30 (`4529a686`); `scale` field
   removed from public `CrashFilter` (`63f3247e`).
2. ~~**Map v2 Phase 3 (FE half)**~~ — done (`52ec2653a40`). v1
   fetch path deleted; `pickFetchPlanV2` viewport optional;
   `?v2=1` flag removed; `CrashMapSection` synthesizes initial
   viewState from county/muni bbox so embeds get fine prebins.
3. **`crash-detail-pages.md`** — per-crash pages aggregating
   NJSP + NJDOT + news links + Bluesky thread embed + Slack
   `#crash-bot` backfill. Builds on the harmonization
   matcher (BE #2 above), so partial implementation possible
   today against the existing matched-pair parquet. Phase 1
   (route + API endpoint) landed in `f26188d125e`.
4. **`crashplot-facet-by-police-dept.md`** — adds
   `Police Department` as a `CrashPlot` `stackBy` option;
   link target for the Alpine '13-'18 annotation tooltip. Needs
   the field exposed in the FE-facing parquet (small backend ask).

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
- `crowdsourced-edits.md` — auth + Slack review queue for
  user-submitted edits

## Other open specs (not yet ranked)

- `crash-log-fsck.md`
- `dvx-gc-ephemeral-artifacts.md`
- `dot-table-vehicle-stats.md`
- `keyboard-nav-and-speed-dial.md` (omnibar portion done; SpeedDial
  + plot/table hotkeys still open)
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
- Statewide map at zoom 8 fetches r7 across 153 shards instead of
  r6 single-file — covered under Map v2 Phase 2 cleanup above.

## Done recently

See `specs/done/` for completed work. Highlights:
- Map v2 Phase 1 (`a965131`, `cb688cf1`, `06a5b26`) — H3 r5
  parent-cell sharding pipeline + manifest carry-overs +
  year column / hex year-sort
- Map v2 Phase 2 client stub (`e09327c`, `24a4d91`) — viewport-
  aware fetch plan, year-range pushdown, dataKind plumbing
- Map perf: per-res hex bin cache + idle prewarm (`7303ae4`)
- Sections jump in omnibar (`19d86c4`)
- `done/county-maps-and-og-images.md` — generalized DeckGL CrashMap
  supersedes the Hudson-only Leaflet implementation; OG images
  shipped at `/og`
- `done/omnibar-navigation.md` — Cmd+K nav for counties/munis +
  in-page section jumping via `use-kbd`
- Pre-2008 NJSP data extension (`done/njsp-pre-2008-crashes.md`)
- Annotations phase 1 (Alpine '13-'18)
- pltly fixes: solo-reset opacity leak + outside-click dismiss
- Slack `accid_thread` NaN-on-int fix
- Harmonize `.dvc` deps (unblocks GHA)
