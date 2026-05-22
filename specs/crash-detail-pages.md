# Individual Crash Detail Pages

Add pages for individual crashes, linked from maps and tables.

## URL Structure

Two ID systems exist:
- **NJDOT PK**: `(year, cc, mc, case)` — e.g. `2023/03/38/2023-00002089`
- **NJSP case number**: only for fatal crashes tracked by State Police

### Proposed Routes
- `/crash/:year/:cc/:mc/:case` — NJDOT crash by full PK
- `/crash/njsp/:id` — NJSP fatal crash by case number (redirects or shows NJSP-specific view)

### URL Encoding
- `case` field may contain slashes or special chars — URL-encode as needed
- Consider a shorter encoding: base64 or hash of the PK for shorter URLs

## Page Content

### Crash Summary
- Date, time, location (address + lat/lng)
- County, municipality (linked to `/c/:county/:city`)
- Severity (fatal/injury/PDO)
- Weather, road conditions, light conditions
- Map pin showing exact location

### Vehicles
- List of vehicles involved (from `vehicles.parquet`)
- Vehicle type, make, model, year
- Travel direction, pre-crash action

### People
- Drivers (from `drivers.parquet`) — age, sex, injury severity, contributing factors
- Occupants (from `occupants.parquet`) — position, restraint use, injury severity
- Pedestrians (from `pedestrians.parquet`) — age, sex, action, injury severity

### Diagram / Map
- Small map centered on crash location
- Show nearby crashes (same intersection?) as context

## Data Access

**Use the existing D1 API** (`api/src/index.ts`). All 6 databases (crashes, vehicles, occupants, pedestrians, cmymc, njsp-crashes) are already deployed to Cloudflare D1 and served via the Worker at `https://crashes-api.ryan-0dc.workers.dev`.

New endpoint needed:
- `GET /njdot/crash?year=&cc=&mc=&case=` — returns crash + joined vehicles/occupants/pedestrians
- Or separate fetches using existing `/njdot/vehicles?crash_ids=` etc. endpoints (already exist)

## Linking

### From Maps
- Click a crash marker on any map → link to crash detail page
- Popup shows summary, "View details →" link

### From Tables
- Municipality pages will have crash tables → each row links to detail page

### From Search
- Future: search by case number, location, date range

## Cross-media aggregation (UGC-ish)

Each detail page should aggregate off-site discussion and primary
sources about the crash. Three upstreams to mirror/backfill:

1. **News articles**: manual links today, but we can parse URLs out
   of historical `#crash-bot` Slack threads (years of replies
   contain shared news URLs). Also expect some semi-structured
   sources — local outlets like Patch, APP.com, NJ.com — that could
   be scraped for known-date-and-location matches.
2. **Bluesky**: `@crashes.hudcostreets.org` posts each fatal crash
   (see `njsp/cli/bsky/`). The post URI becomes the canonical
   thread root; any replies on Bluesky should render on the crash
   page as a conversation view. Long-term: auto-post new notes and
   allow comment threads.
3. **Slack `#crash-bot`**: the Slack bot has posted a notification
   per crash for years. Replies in those threads contain news links
   and user commentary. Backfill task: walk the channel history,
   tie each thread to its corresponding crash id, extract URLs and
   anonymized quotes.

### Data schema

Store cross-references as:

- `crash_refs.parquet` (project-tracked, maybe DVX):
  `crash_pk`, `source_type` (`news` | `bluesky` | `slack` | `other`),
  `url`, `title`, `summary`, `captured_at`, `author_handle?`
- Slack threads mapped to crash IDs via a join on the bot's post
  metadata (`accid` was typically included in each post).

### Rendering

On `/crash/:year/:cc/:mc/:case`:

- A **"References"** section listing news links (sorted by date)
- A **"Discussion"** section embedding (not linking to) the Bluesky
  thread — avoids requiring a Bluesky account
- A **"Slack thread"** summary (counts, notable quotes) — possibly
  aggregated/anonymized depending on privacy constraints
- Admin action: "Add a reference" → PR template pre-filled

Each reference is one Markdown block. PR-editable; aspirationally
editable through a light auth flow later.

### Relationship to page-level annotations

Per-crash refs are the fine-grained analog of
`specs/page-annotations.md`. Share the same YAML/Markdown authoring
pattern; `crash_refs` is keyed by PK, annotations are keyed by geo
+ page + year range.

## Slack backfill

See also `specs/slack-sync-lookback.md` (orthogonal — that's about
pipeline-run lookback). A separate task:

1. Use Slack Web API (`conversations.history`) to pull
   `#crash-bot` channel history.
2. For each thread, pull `conversations.replies`.
3. Parse each bot-post for the `accid` (typically embedded in the
   message text or as metadata) to tie to a crash PK.
4. For each reply, extract URLs (and surrounding message text for
   title/summary). Dedupe URLs across threads.
5. Emit `slack_crash_refs.parquet` with one row per reply-URL pair.
6. Merge into `crash_refs.parquet`.

## Implementation Order
1. ✅ Add `/njdot/crash` API endpoint — `api/src/index.ts`, joins V/O/P
   in one round-trip.
2. ✅ Add route + page component for `/crash/:year/:cc/:mc/:case`
   (`f26188d125e`).
3. ✅ Build crash detail page with basic crash info — Location,
   Conditions, Casualties sections.
4. ✅ Add vehicle/occupant/pedestrian sections — Vehicles (with nested
   occupants) + Pedestrians & cyclists.
5. ✅ Wire up NJDOT crash-table date cells → detail page
   (`crashDetailHref` helper in `crash.ts`; `getNjdotCrashRows` `dt`
   cell is now a `<Link>`). Unit + e2e tests added.
6. Add NJSP cross-reference for fatal crashes — needs the
   `njsp_njdot_match.parquet` pairs exposed to the FE (no D1 table for
   matches yet; small backend ask).
7. Slack backfill → `crash_refs.parquet`
8. "References" section on detail pages rendering `crash_refs`
9. Embed Bluesky thread view
10. PR-template "Add a reference" affordance

Steps 1–5 are the reachable-detail-page MVP (Phase 1 = 1–4, Phase 2 =
5). Steps 6–10 (cross-media aggregation) are independent follow-ups;
6 unblocks the rest with a modest backend addition. Polish noted while
verifying step 5: `CrashDetailPage` shows "condition 5" verbatim for
uninjured occupants — `ConditionMap` only labels codes 0–4 (code 5 =
"no apparent injury"); the page needs its own extended label map since
the shared `ConditionMap` length gates icon rendering.
