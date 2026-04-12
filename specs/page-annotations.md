# Page / plot annotations

## Motivation

Some facts about the data are too specific or subjective to bake into
code, but too important to leave undocumented — they belong _next to_
the plot or table where a user would otherwise be confused. Two
seeding examples:

- **Bergen / Alpine, 2013-2018**: NJDOT crash counts drop ~75% because
  the Palisades Interstate Parkway Police Department stopped filing
  reports during that period (Route 445 crashes went from 134/yr in
  2012 to 1/yr in 2013-2018, returning to 230/yr from 2019). This
  warrants a prominent note on the Alpine muni page — and possibly
  on the plot toolbar — but **not** on the Bergen County parent page,
  where Alpine's share is too small to move the line meaningfully.
- Other muni-level reporting gaps listed in `tmp/gap-candidates.md`
  (Bridgeton 2018-2020, Ocean City 2019-2021, Salem 2005-2008, …).

The broader pattern: specific plot/config combinations should be able
to surface notes. This is similar in spirit to how a given _slice_ of
a higher-dimensional plot might have a caveat that doesn't apply at
other slices.

## Design

### Data model

An annotation is an object with:

- `id`: short slug for referencing (URL param, linking, editing)
- `title`: short headline (≤80 chars)
- `body`: Markdown (possibly several paragraphs, with links)
- `applies_to`:
  - `geo`: `{ cc?, mc? }` — statewide if both absent, county if only
    cc, muni if both
  - `pages`: which pages/sections on the site (e.g. `home`,
    `njdot-crash-plot`, `njsp-crash-list-table`, `ytd-plot`)
  - `year_range`: `[start, end]` (inclusive) — the annotation
    highlights a specific range on the plot
  - `data_source`: `njsp` | `njdot` | `both`
  - `severity`: `info` | `caveat` | `warning`
- `authored`: `{ author, date }` — treat like a revision-tracked
  artifact
- `refs`: array of `{ url, label }` — links to news articles, PD
  statements, primary sources

### Storage

YAML under `www/public/annotations/*.yml`, one file per annotation,
loaded on demand by an `AnnotationsProvider`.

Alternative: a single `annotations.yml` indexed by geo/page. Smaller
footprint, easier to diff; fine while the list is <~200 entries.
Default to the single-file approach and split later if needed.

### Rendering

Three surfaces:

1. **Inline plot annotation**: a small "!" badge near the plot title
   (like `PlotInfo`) that expands into the note; optionally a shaded
   region on the x-axis for the affected `year_range`.
2. **Banner above the page/section**: when ≥1 annotation with
   `severity: warning` applies to the current geo, show a dismissable
   banner at the top of the crash sections.
3. **Dedicated "Notes" section** on muni/county pages: list all
   annotations that apply to this geo, sorted by date.

Annotations are inherently subjective. Rendering respects both
`severity` and plot scale:

- A warning on Alpine's crash plot is prominent (drops are >50%).
- The same warning inherited to the Bergen County parent should
  **not** render by default — surface it only if the user drills
  into Alpine, or via a "Show sub-region notes" affordance on the
  parent.

The rule: an annotation auto-renders on exact geo match; appears as
a hint (e.g. small badge) on the direct parent geo if its magnitude
exceeds a threshold (say, >10% of parent's crash count); otherwise
it's only available via a "Notes" page or muni drill-in.

### Authoring & "UGC-ish"

Aspirationally, these should feel like they belong to the community:

- Editable as Markdown files checked into the repo — PRs welcome
- Each has a stable URL (`/notes/<id>`) so they're linkable
- Eventual: mirror to Bluesky (post a skeet per annotation with a
  link back); allow comments/threads via ATProto or similar
- Each annotation should show a "last updated" and a "propose edit"
  link → opens a GitHub PR template prefilled with the file path

This overlaps with the per-crash discussion aggregation in
`specs/crash-detail-pages.md`: annotations are the geo/page-level
analog of per-crash notes. Both want the same "quasi-UGC / cite
external sources / mirror across media" pattern.

## Plan

### Phase 1: single-geo annotation, hard-rendered

1. Define the YAML schema (typed via TS types in
   `www/src/annotations/types.ts`).
2. Build `AnnotationsProvider` that loads `annotations.yml` once.
3. Build `<Annotation>` component: badge + expandable note.
4. Seed with the Alpine 2013-2018 entry. Render on the muni page
   near `CrashPlot` and the crash table.
5. Verify: visiting `/c/bergen/alpine` shows the badge; visiting
   `/c/bergen` doesn't.

### Phase 2: more annotations + bulk UX

6. Add the confirmed entries from `tmp/gap-candidates.md` (after
   hand-review to distinguish real reporting gaps from COVID /
   construction / real traffic changes).
7. Shade the `year_range` on the plot x-axis for warning-severity
   annotations.
8. Add a site-wide "Notes" index page listing all annotations.

### Phase 3: propose-edit / mirror

9. "Propose edit" link that opens a GH PR template.
10. Cross-post to Bluesky with a back-link.
11. Consider pulling comments/discussions back from Bluesky into
    a read-only thread renderer.

## Open questions

- Should annotations support **multi-geo scope** (e.g. "this
  statewide change affected all counties on date X")? Probably yes —
  `applies_to.geo` should accept a list of `{cc?, mc?}` entries.
- Inheritance rules for county/statewide rollups. Start with "render
  on exact geo match only"; add the magnitude-threshold bubble-up
  later.
- Dismiss-state per annotation: cookie/localStorage to silence
  banners? Probably not worth it initially.

## Out of scope

- Authoring UI inside the site (always edit via PR for now).
- Per-crash annotations — those live in
  `specs/crash-detail-pages.md`.
