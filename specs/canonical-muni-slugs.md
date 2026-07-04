# Canonical short muni slugs (`/{slug}`)

## Motivation

Users type `crashes.hudcostreets.org/hopewell-boro` and hit "Page Not Found"
(the app's generic fallback). The path only knows about `/c/{county}/{muni}`
routes. The muni name alone should be enough to reach the page — county
context is often implicit (there's exactly one Hopewell Boro in NJ) or can
be disambiguated cheaply (Washington Twp exists in 6 counties).

The design covers three related pieces:

1. A `/{slug}` route that accepts any human-plausible spelling of a muni
   and lands on the correct page.
2. A canonical short URL emitted by that route (URL bar shows `/hopewell-boro`
   for unique slugs, `/c/mercer/hopewell-twp` after disambig picker).
3. Fixes to `cc2mc2mn.json` so "Union" (Twp, Hunterdon) doesn't visually
   collide with "Union City" (Hudson) in in-app pickers.

## What ships today (MVP)

`www/src/routes/MuniSlugRoute.tsx` — new route at `/:muniSlug`:

- **Exact match via `muniKey`, unique across NJ** → `<Navigate replace>` to
  `/c/{county}/{muni}`. URL bar reads `/c/...` after redirect.
- **Exact match, >1 results** → disambiguation panel listing each
  `{Muni Name}, {County} County` as a link to `/c/{county}/{muni}`.
- **No exact match** → not-found panel with fuzzy suggestions via
  `suggestMunisStatewide()` (state-wide Levenshtein ranking, `cc=99` Port
  Authority filtered out).

`suggestMunisStatewide()` lives in `www/src/county.ts`. It reuses the same
Levenshtein helper as the existing per-county `suggestMunis()`.

## Follow-ups

### 1. Emit `/{slug}` as canonical for unique munis (no redirect)

`MuniSlugRoute` currently redirects to `/c/{county}/{muni}`. To keep the
short slug in the URL bar and render the muni page inline, `GeoFilterProvider`
needs to accept an override `{cc, mc, countyName, municipalityName}` instead
of always reading from `useParams` (which is keyed to `/c/:county/:city`).

Cleanest approach: hoist geo resolution out of `GeoFilterProvider` into a
route-shape-agnostic hook that either the route params OR an explicit
`{cc, mc}` from `MuniSlugRoute` can drive.

Emit `<link rel="canonical" href="/c/{county}/{muni}" />` (or vice-versa) so
Google indexes one URL.

### 2. Accept a wider alias set

Beyond exact-`muniKey` match, also accept:

- **Stem-only** — `/hopewell` matches "Hopewell Boro" + "Hopewell Twp"
  (both in Mercer). Currently falls through to fuzzy suggestions; should
  render the disambig picker instead (like the multi-match case).
- **`{stem}-{county}` suffix** — `/washington-bergen` disambiguates
  Washington Twp (Bergen) from the other 5. Needed for the "shortest
  canonical" rule when no shorter unique form exists.

Aliases from URL to (cc, mc) mapping should be precomputed once from
`cc2mc2mn.json` (client-side, at load time), not looked up per-navigation.

### 3. Canonical-slug algorithm

Emit the **shortest slug that uniquely resolves**:

| Muni | Canonical slug |
|---|---|
| Hopewell Boro (Mercer) | `/hopewell-boro` (unique — no other Hopewell Boro) |
| Hopewell Twp (Mercer) | `/hopewell-twp` |
| Washington Twp (Bergen) | `/washington-bergen` (or `/washington-twp-bergen`) |
| Jersey City (Hudson) | `/jersey-city` (CITIES member — `City` is preserved) |
| Union City (Hudson) | `/union-city` |
| Union Twp (Hunterdon) | `/union-twp-hunterdon` (disambigs from Union City + Union Twp Union County) |
| Trenton (Mercer) | `/trenton` (unique stem) |

### 4. Preserve `City` suffix for `CITY_STEMS`

The Python harmonizer already knows about the "cities where 'City' is
canonical" list:

```py
# njdot/harmonize_muni_codes.py:45-46
CITY_STEMS = ['Atlantic', 'Jersey', 'Ocean', 'Union']
CITIES = [f'{stem} City' for stem in CITY_STEMS]
```

Frontend needs the same list. Options:

- **Export a shared TS constant** at `www/src/lib/city-stems.ts` and keep it
  in sync manually with the Python source (small, rarely changes).
- **Emit from the Python side** — write `cc2mc2mn.json` (or a sidecar)
  with a `city_stems: string[]` key, read by the FE.

Prefer the sidecar so the source of truth stays in Python.

### 5. Fix name collisions in `cc2mc2mn.json`

Current bugs found (2026-07-04):

- `cc=10 (Hunterdon) mc=25` name `"Union"` (Union Twp) collides visually
  with `"Union City"` (Hudson `cc=9 mc=10`).
- `cc=13 (Monmouth) mc=37` name `"Ocean"` (Ocean Twp) collides with
  `"Ocean City"` (Cape May).
- `cc=15 (Ocean) mc=21` name `"Ocean"` (Ocean Twp) — same collision.
- `cc=20 (Union) mc=19` name `"Union"` (Union Twp) — collides with Union City
  AND with the Hunterdon Union Twp.

Root cause: `njdot/harmonize_muni_codes.py:build_names()` only preserves the
type suffix when `(cc, stem)` collides *within the same county* (line 341:
`df2.duplicated(['cc', 'stem'], keep=False)`). It doesn't consider:
- Collisions with `CITIES` (the enumerated list).
- Cross-county stem collisions.

Fix: extend the `full_name_mask` to also cover `stem ∈ CITY_STEMS` and any
`stem` that appears in more than one row state-wide.

## Testing

- Unit: `www/src/county.test.ts` gains `suggestMunisStatewide()` cases.
- E2E: navigate to `/hopewell-boro`, `/hopewell`, `/washington-twp`,
  `/notatown` — verify redirect / picker / suggestions.
- CIC: prod smoke-test a handful of shortcut URLs after deploy.
