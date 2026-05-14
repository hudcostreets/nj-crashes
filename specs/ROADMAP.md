# Roadmap

Living doc capturing relative priority across open specs. Update as
priorities shift; treat as a default ordering, not a contract.

## Active sequence (2026-04-28)

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
3. ~~**Map v2 Phase 3 (BE half)**~~ — done. `map.dvc` cmd
   rewritten to drop v1 outputs (`55cc13ba1f2`); local
   re-run shrunk `map/` 377MB → 127MB. CFP redeployed
   (`d9c8346ce4a`); `map_sync.dvc` ran `aws s3 sync --delete`
   so v1 S3 keys are gone (`manifest.json`, `by-year/`,
   `by-year-county/`, `hex-r{7,8}/` all return 404).

### Frontend (laptop)

1. ~~**Map v2 Phase 2 cleanup**~~ — done. Picker falls back to
   r6 single-file when shard count >30 (`4529a686`); `scale` field
   removed from public `CrashFilter` (`63f3247e`).
2. ~~**Map v2 Phase 3 (FE half)**~~ — done (`52ec2653a40`). v1
   fetch path deleted; `pickFetchPlanV2` viewport optional;
   `?v2=1` flag removed; `CrashMapSection` synthesizes initial
   viewState from county/muni bbox so embeds get fine prebins.
3. ~~**`map-multi-res-single-files.md`**~~ — done locally
   (`6155bea2287`, `335c83cdc9d`, `728128be313`). Per-resolution
   single-file fallbacks (`hex-r{6,7,8,9}.parquet`), picker prefers
   the finest single-file ≤ chosen res, `maxPointShards` bumped 2→10
   so county/muni z11+ views render raw points, `getResolution`
   render-res clamp fixes the "skinny columns on visible lattice"
   bug. Verification matrix complete; one follow-up logged: the
   year-range row-group pushdown isn't actually shrinking fetched
   bytes (~3% at /map z8.5 single-file, occasionally negative for
   sharded r9). Local-only — not pushed yet.
4. **`crash-detail-pages.md`** — per-crash pages aggregating
   NJSP + NJDOT + news links + Bluesky thread embed + Slack
   `#crash-bot` backfill. Builds on the harmonization
   matcher (BE #2 above), so partial implementation possible
   today against the existing matched-pair parquet. Phase 1
   (route + API endpoint) landed in `f26188d125e`.
5. **`crashplot-facet-by-police-dept.md`** — adds
   `Police Department` as a `CrashPlot` `stackBy` option;
   link target for the Alpine '13-'18 annotation tooltip. Needs
   the field exposed in the FE-facing parquet (small backend ask).

Annotations explicitly deprioritized — they only surface on
random sub-pages most users won't encounter.

## Home-page rework (2026-05-14)

Cluster of UX work surfaced in a single session; some small, some
significant. Order is roughly small→large; (a)/(b) land first as a
warm-up.

- (a) **Intro paragraph: add AASHTO data source link** — third link
  alongside NJSP + NJDOT, pointing at `https://njdot.aashtowaresafety.net/njdot-crash-data-dashboard`.
  Trivial.
- (b) **Map default year range** — current `[2019, 2023]` in
  `CrashMapSection.tsx:119`. Bumped to `[2019, 2025]` (7 years).
  Year range is roughly free at fixed zoom — hex parquets are pre-
  aggregated per cell; year filtering changes counts per cell, not
  the fetched cell count. (And year-range row-group pushdown
  doesn't currently shrink bytes anyway, so we fetch the full file
  regardless.)
- (c) **Section reorder**: Map first (visual hook), then unified
  NJSP plot+table, then unified NJDOT plot+table. Annotations etc.
  below.
- (d) **Sticky geo nav** (state → county → muni) accessible on every
  page. Desktop = always-visible compact breadcrumb bar under main
  nav, county/muni dropdowns inline. Mobile = collapsed pill (`📍
  Hudson > Jersey City`); tap → slide-up sheet; auto-hide on
  scroll-down, show on scroll-up. Single React component, container
  queries (or vw breakpoint) to switch render. Existing
  `GeoNavBar` is the starting point.
- (e) **Unify NJSP plot + Recent Fatal Crashes table** into one
  `NjspSection` component. Geo filter, year range, type filters all
  drive both halves. Same factoring as (f).
- (f) **Unify NJDOT plot + crash table** into one `NjdotSection`.
  Today `CrashPlot` (`/njdot`) and `NjdotCrashesSection` (annual
  stats + per-crash table) are siblings; merge so filters cascade.
  Annual Statistics table is then conceptually a tabular view of
  the same plot bins (see (h)).
- (g) **Map click-through to crash list**: clicking a hex stack
  sets URL params (cell ID + year range) that filter a table below
  the map. Table reuses the existing `NjdotCrashesSection`
  component, scoped to the cell. Brushing (hover-highlight) is
  nice-to-have; click-pin is the core. Tooltip stays for quick
  numbers.
- (h) **Plot ↔ tabular view contract**: every plot gets a
  collapsible companion table. Two tabs: *raw rows* (the crashes in
  scope, paginated; reuses crash tables) and *aggregated bins*
  (the plot's underlying x/y, downloadable as CSV/parquet). Annual
  Statistics table becomes the (aggregated) view of CrashPlot bins
  by year + condition. Pattern generalizes to every plot on the
  page.
- (i) **Crash detail pages** — per-crash routes (NJSP and NJDOT,
  with harmonized cross-links where matched). Blocker for restored
  Bluesky posting. Partially specced in
  `crash-detail-pages.md` already. **PK question** (open): use
  `(source, year, cc, mc, case|accid)` as PK string, or assign
  separate auto-inc IDs per source + a mapping table. Lean toward
  the structured PK — human-readable, no migration surprises if
  source PKs already collide. Bluesky posts can encode the PK in
  the URL.
- (j) **Hex stack → readable location name**: ✅ v0 landed
  (`njdot export_hex_sld` → `hex-sld.parquet`, ~1.7 MB sidecar
  keyed by H3 cell; `useHexSld` hook → `CrashTooltip`). Snaps each
  hex centroid to nearest tenth-mile MP point in
  `nj_mp_tenths.parquet` (KD-tree) and surfaces `SLD_NAME`. Next:
  cross-streets via MP intersection routing (find two crossing
  roads near the centroid, name both) for "Route 9 between Main St
  and 3rd Ave"-style labels.
- (k) **Vehicle stack/aggregation by manufacturer** — extend
  CrashPlot StackBy with a `manufacturer` option for
  `measure='vehicles'`. Parallel to (e)–(g), not blocked by them.
  Data prereq: normalize free-text AASHTO `Vehicle Make` (similar
  messiness to `Removed To`); legacy NJDOT has a structured field
  already. Top-N + "Other" bucket on the FE.

Dependency notes: (g) wants (e)+(f) done first (otherwise the
"table below" doesn't have a clean home). (j) depends on the
shapefile bulk download. (i) is independent and unblocks the
Bluesky restore. (k) only depends on the vehicle-make
normalization pipeline; no UI deps.

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
