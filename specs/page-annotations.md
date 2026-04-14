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

### Rendering — a zoo of anchor/display kinds

Annotations range from "flat bullet of text pinned to a geo" up to
"fully custom React component that draws interactive overlays." Rather
than pick one abstraction, the system supports a small fixed set of
**kinds**, each with a known renderer. Every annotation declares its
`kind`; the flat-data kinds cover the UGC / crowdsourced-comment use
case, and the `custom` kind is an escape hatch for irreducibly
bespoke visuals.

| kind | declared fields | renderer behavior |
|------|----------------|-------------------|
| `panel` | `title`, `body`, `refs` | Section-level banner (the original design). Sits above the relevant plot/table. |
| `plot-range-shade` | `title`, `body`, `year_range` | Shade the plot's x-range; warning icon pinned at upper-right; hover for tooltip with title/summary; optional "notes" icon below plot opens full panel. **This is what Alpine uses.** |
| `plot-point-marker` | `title`, `body`, `x_value` | Single annotation arrow + callout at a specific x-value (e.g. "this spike coincides with <event>"). |
| `plot-series-caption` | `title`, `body`, `series_match` | Caption attached to a specific trace name / stack segment (e.g. "this category was introduced in 2012"). Rendered near the legend entry. |
| `custom` | `component: string`, arbitrary `props: object` | Looks up `component` in a registry of React components; renders it with `props`. Lets us ship truly bespoke visuals (e.g. HBT's bus-lane-capacity overlay) without inventing new kinds for every one-off. |

All kinds share the `applies_to` (geo/pages/data_source) and `severity`
fields, so the targeting logic is common; only the render is kind-
specific.

**UGC / comments**: the flat-data kinds (`panel`, `plot-range-shade`,
`plot-point-marker`, `plot-series-caption`) are all authorable via
the crowdsourced-edit flow in `specs/crowdsourced-edits.md`. The
`custom` kind requires a code change (new component registered) — not
something a reader can submit via form. That's fine: `custom` is rare
and treated as developer-only.

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

### Phase 1: single-geo annotation, hard-rendered (done 2026-04-12)

1. ✅ JSON schema + TS types in `www/src/annotations/types.ts`.
   (YAML deferred until we add a yaml parser dep.)
2. ✅ `useAnnotations({ page, cc, mc })` hook loading
   `www/public/annotations.json` once and filtering by geo+page.
3. ✅ `<Annotation>` / `<AnnotationsPanel>` components (kind=`panel`).
4. ✅ `plot.ts`: `toPlotLayers()` producing Plotly `shapes` +
   `annotations` for `plot-range-shade`. Integrated into `CrashPlot`.
5. ✅ Alpine 2013-2018 seed entry: reddish tint across 2013-2018 bars
   with ⚠ icon pinned upper-right of the shaded band; hover for
   tooltip.
6. ✅ Verified on `/c/bergen/alpine` (shape present); not on
   `/c/bergen` (shape absent).

Follow-ups from phase 1:
- Hover zone currently only on the ⚠ icon, not the full shaded
  region. Full-region hover needs an invisible scatter-marker trace
  spanning the x-range; add when we have a second example.
- Add a footer icon below the plot (next to `ControlsGear` or
  symmetric lower-right) that re-opens the full panel-style note.
- Currently the `panel` renderer is only wired into the crashes
  table below the plot. Decide whether to keep both panel+shade or
  only shade.

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
