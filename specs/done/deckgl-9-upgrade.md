# Spec: upgrade deck.gl 8.9 → 9.x ✅ done (2026-05-22)

## Motivation

`crashes` was on deck.gl `8.9.x` — two majors behind. The sibling map projects
(`jc-taxes`, `household-vehicles`) are on `9.2.x`, and the shared map toolkit
[`@rdub/deck-map`] targets deck.gl 9. Upgrading unblocks adopting
`@rdub/deck-map` and gets `crashes` onto a maintained deck.gl line.

## What it took — a dep bump + one mechanical TS change

The upgrade turned out small. Two commits' worth of risk areas in the original
spec (`HeatmapLayer` / aggregation-layers, `ColumnLayer` props, react-map-gl v8
`<Map>` API) were **all non-issues** for our usage.

### Deps

- `@deck.gl/{core,layers,react,aggregation-layers}` `^8.9` → `^9.2` (resolves
  to 9.3.x).
- Dropped `@deck.gl/mapbox` — confirmed unused (no import).
- `react-map-gl` `^7.1` → `^8`; `maplibre-gl` `^3.6` → `^5`.
- `mapbox-gl` / `@types/mapbox-gl` left as-is — legacy-Leaflet-route only.

### The one code change — deck.gl 9 removed the `/typed` entry points

deck.gl 9 is TypeScript-native; the deck.gl-8 `/typed` subpaths are gone. The
only edits were six import lines in `www/src/map/CrashMap.tsx` and
`www/src/map/StackedHexLayer.tsx`:

- `@deck.gl/react/typed` → `@deck.gl/react`
- `@deck.gl/layers/typed` → `@deck.gl/layers`
- `@deck.gl/aggregation-layers/typed` → `@deck.gl/aggregation-layers`
- `@deck.gl/core/typed` → `@deck.gl/core`

No prop changes: stock layers (`GeoJsonLayer`, `ScatterplotLayer`,
`HeatmapLayer`, `ColumnLayer`), the `<DeckGL><Map/></DeckGL>` nesting, the
`ColumnLayer` stacked-segment `position[2]` trick, and the inline Stadia raster
basemap style all worked unchanged under deck.gl 9 / react-map-gl 8 / maplibre 5.

## Verified

- `tsc` clean, `pnpm build` succeeds, all 56 `vitest` unit tests pass.
- In-browser (`/map` route + the `CrashMapSection` Home embed): all three modes
  — scatter, heatmap, hexbin-3D — render correctly; Stadia basemap (labels,
  route shields), hex columns, severity colors, controls panel all intact.

### Note on verification

The deck.gl 9 render loop is rAF-gated; a **backgrounded** browser tab throttles
it, leaving the canvas un-resized (300×150) and frames blank. Automated/headless
checks against a background tab give false "broken map" readings — verify the
map in a **foregrounded** browser.

## Follow-up — adopt `@rdub/deck-map`

Now that `crashes` is on deck.gl 9:

- Replace `www/src/map/hooks/useTouchPitch.ts` with the package's
  `useTouchPitch` (the two were byte-identical).
- Replace the hand-rolled `rasterStyle()` with `stadiaRasterStyle()`.
- Wire via [`pds`] — `pds init` the local `~/c/js/deck-map`, or `pds gh` once
  that package has a published dist branch.

[`@rdub/deck-map`]: https://github.com/runsascoded/deck-map
[`pds`]: https://github.com/runsascoded/pnpm-dep-source
