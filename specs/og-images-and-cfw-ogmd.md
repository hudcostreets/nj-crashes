# OG images + CFW custom OGMD

Generate per-scope OG images (counties, munis, statewide) and serve
scope-specific Open Graph metadata via a Cloudflare Worker. Also acts as a
regression checker for default `?llz=` framings baked into `LLZ_OVERRIDES`.

## Motivation

- Social cards for `/c/<slug>` and `/c/<slug>/<muni>` should preview the
  scope's crash map, not a generic site card.
- Picking reasonable default map views per scope is hard (variable AR, tall
  hex spikes like Bergen's GWB stack). A script that SSes every scope and
  flags cropping gives us a feedback loop for tuning `LLZ_OVERRIDES` — and
  for deciding when a scope needs an explicit override at all.
- NJDOT data updates annually, so output is DVX-able (not per-push).

Supersedes Phase 7 of `county-maps-and-og-images.md` (which predates the
current `CrashMapSection` embed + `LLZ_OVERRIDES` design).

## Phases

### Phase 1 — Script: generate OG images for counties

`scripts/og-images.ts` using Playwright. Invoked as
`pnpm og:images [--cc N]`.

Inputs:
- `www/public/njdot/map/manifest.json` for the scope list
  (start: statewide + 21 counties; munis deferred to Phase 3)
- Served bundle (see Serving below)

Flow, per scope:
1. Navigate to `/c/<slug>#map`
2. Wait for a page-injected `window.__mapReady` flag (emitted when
   `useCrashData` reaches `ready` + map canvas has non-zero pixels).
3. `page.locator('div[style*="position: relative"] canvas').first().screenshot(...)`
   at viewport 1200×630 (OG standard, desktop only for MVP).
4. Write to `www/public/og/c/<slug>.png`. Statewide → `og/index.png`.

Manifest emitted alongside: `www/public/og/manifest.json` listing every
generated image with its scope keys, bbox, timestamp, and generator git-sha.

Failure behavior: on any scope failure, write an error line to the report
and continue with the rest. Exit non-zero if any scope failed.

Serving: `pnpm build && pnpm preview` on a script-chosen port (hash project
name + "og" to stay out of the way of the dev server). Deterministic
bundles → stable DVX inputs. The script boots preview, waits for the port,
runs, shuts down.

Scope list:
- Statewide → `og/index.png`
- 21 counties → `og/c/<county-slug>.png`

### Phase 2 — Margin-check / llz regression report

Same tool, `--check` mode. After screenshotting, analyze the canvas
pixels:
- Find the colored-pixel envelope (non-basemap alpha, non-outline).
- Compute margin to each container edge.
- Report scopes where margin < 10px on any edge (cropped) or > 15% of
  container dim on all edges (excessive whitespace).

Output: `tmp/og-margin-report.json` with per-scope verdict and suggested
action ("add override", "review existing override", "OK").

This is what we'd run after any change to `fitBoundsToView`, pitch math,
bar-height scaling, or data that would plausibly re-frame the map.

### Phase 3 — Munis

Same pipeline, expanded scope:
- All `(cc, mc)` pairs in the manifest that have any crash rows.
- Output: `og/c/<county-slug>/<muni-slug>.png`
- Likely ~450 scopes total. Run with `--concurrency N` (Playwright contexts
  in parallel). Estimate ~2min at N=4.

### Phase 4 — DVX-ify

`og-images.dvc` with:
- `cmd: pnpm og:images` (or equivalent)
- `deps`:
  - `www/public/njdot/map/manifest.json` (bboxes)
  - `njdot/data/crashes.parquet.dvc` md5 (annual data)
  - Selected source files: `www/src/map/{CrashMap,CrashMapSection,StackedHexLayer,fitBounds}.tsx`,
    plus `LLZ_OVERRIDES`. (DVX supports source-file deps.)
- `outs`: single tar/zip bundle OR a committed directory with index.json.
  DVX prefers single-file outputs; leaning toward a tarball with
  `og-manifest.json` as a tracked index for quick queries.

Hooked into the annual refresh chain rather than `daily.yml` — munis list
doesn't change day-to-day.

### Phase 5 — Cloudflare Worker for custom OGMD

Current SPA `index.html` has static OG tags (`og:image`, `og:title`,
etc.). Crawlers rarely execute JS, so per-route OGMD has to be injected
server-side.

Approach: CF Worker fronting the static site.
- On every request, serve the static `index.html` but rewrite the `<head>`
  OG tags based on the URL path (`/`, `/c/<slug>`, `/c/<slug>/<muni>`).
- `og:image` → absolute URL to `og/…/<slug>.png` (generated in Phases 1-3).
- `og:title`, `og:description`, `twitter:*` → scope-specific strings
  (e.g. "Monmouth County crash map — 2019-2023").
- Scope metadata (title, description, bbox, counts) lives in
  `www/public/og/manifest.json` (written by the SS script); the Worker
  fetches-or-bundles it.

Separate concern from the SS tool — can land independently. Depends on
Phase 1/3 outputs existing.

### Phase 6 — Shareable bbox URL param (optional future)

Orthogonal observation from the llz-is-pixel-exact conversation: a
`?bbox=s_w_n_e` param would encode the semantic view (geographic region)
rather than a pixel-exact fit, so desktop-shared URLs frame comparably on
mobile. `CrashMap.fitBoundsToView` already computes the fit; decoding
`?bbox=` is a small addition.

Not required for OG/CFW work. Noted here because it intersects the same
"framing per scope" design space.

## Open questions

- **Output bundling.** DVX prefers single-file outputs. A tarball makes
  indexing awkward (have to untar to read). Option: emit both a tarball
  AND a checked-in `og-manifest.json` — only the tarball is DVX-tracked;
  the manifest is a cheap query index derived from the tarball. Or: use
  a directory output (DVX supports it) and accept per-file md5 tracking.
- **Wait-for-ready hook.** The script needs a reliable "map is rendered
  and settled" signal. Adding a `window.__mapReady` boolean from
  `CrashMapSection` (set after `result.status === 'ready'` + a frame)
  is straightforward and has no production impact.
- **Concurrency vs flakiness.** deck.gl / WebGL contexts can be flaky
  under high concurrency. Start at `--concurrency=2` and tune.
- **Pre-fit hydration race.** `CrashMapSection` lerps initial view from
  window width, then re-fits on ResizeObserver. SS must fire only after
  the post-measure fit settles, not the pre-measure guess. Ready-flag
  should gate on that.

## Concretely, first-session scope

1. Land `window.__mapReady` hook (1 small edit to `CrashMapSection`).
2. Write `scripts/og-images.ts` for counties only (Phase 1).
3. Run it, eyeball outputs, iterate on LLZ_OVERRIDES.
4. Add `--check` mode (Phase 2) once outputs look right.
5. Munis, DVX, CFW OGMD are follow-up sessions.

Not demo-critical; targeted for post-demo (4/25).
