# Spec: upgrade deck.gl 8.9 → 9.x

## Motivation

`crashes` is on deck.gl `8.9.x` — two majors behind. The sibling map projects
(`jc-taxes`, `household-vehicles`) are on `9.2.x`, and the new shared map
toolkit [`@rdub/deck-map`] targets deck.gl 9. Upgrading:

- unblocks adopting `@rdub/deck-map` (drops the duplicated `useTouchPitch`,
  the hand-rolled Stadia basemap style, and eventually a shared `<DeckMap>`
  shell);
- gets `crashes` onto a maintained deck.gl line.

## Current state

`www/package.json` deck.gl / basemap deps:

```
@deck.gl/aggregation-layers  ^8.9.36
@deck.gl/core                ^8.9.34
@deck.gl/layers              ^8.9.34
@deck.gl/mapbox              ^8.9.36   ← declared, NOT imported by the active map
@deck.gl/react               ^8.9.34
react-map-gl                 ^7.1.7    ← used via `react-map-gl/maplibre`
maplibre-gl                  ^3.6.2
mapbox-gl                    ^3.0.1    ← legacy Leaflet route only
@types/mapbox-gl             ^2.7.19   ← legacy only
```

deck.gl is used in two files only — `www/src/map/CrashMap.tsx` and
`www/src/map/StackedHexLayer.tsx` — with **stock layers only** (`ColumnLayer`,
`ScatterplotLayer`, `GeoJsonLayer`, `HeatmapLayer`); no custom layers or
shaders. `viewState` is controlled; the basemap is a `react-map-gl/maplibre`
`<Map>` under `<DeckGL>`.

> The legacy Leaflet map (`www/src/map/hudson/`, `cluster*.tsx`) is independent
> of deck.gl — **out of scope** here.

> File/usage details above are from a point-in-time survey — verify against
> current code before relying on them.

## Scope

**In:** deck.gl `8.9 → 9.x`, plus the `react-map-gl` / `maplibre-gl` bumps it
pairs with. **Out:** the legacy Leaflet map, the cells-API / parquet data
layer (unaffected), any feature changes.

## Steps

### 1. Bump packages

- `@deck.gl/{core,layers,react,aggregation-layers}`: `^8.9` → `^9.2` (latest
  9.x; `jc-taxes` pins `9.2.6`).
- Drop `@deck.gl/mapbox` (unused by the active deck.gl map — confirm no import
  first).
- `react-map-gl`: `^7.1` → `^8.x` — aligns with `jc-taxes` (8.1). Note this is
  react-map-gl's *own* v7→v8 breaking change (separate upgrade guide); can be
  staged separately if it complicates the deck.gl bump.
- `maplibre-gl`: `^3.6` → `^5.x` (`jc-taxes` uses 5.17; react-map-gl 8 expects
  maplibre 4/5).
- deck.gl 9 pulls luma.gl 9 transitively — no direct `@luma.gl/*` dep needed
  (crashes imports none).
- `mapbox-gl` / `@types/mapbox-gl` — legacy Leaflet only; leave, or excise in a
  separate cleanup.

### 2. Apply the upgrade, watching known risk areas

Follow the official guides: [deck.gl upgrade guide] and the react-map-gl
v7→v8 guide. For *this* codebase specifically:

- **luma.gl 9** — deck.gl 9 is a WebGL2/WebGPU rewrite. Stock layers only here
  → low risk, but GL context init differs; WebGL1-only devices are dropped
  (negligible).
- **`@deck.gl/aggregation-layers` / `HeatmapLayer`** — *highest risk*.
  Aggregation layers were reworked across 9.0/9.1; verify `HeatmapLayer` props
  (`getWeight`, `getPosition`, `radiusPixels`, `colorRange`, `aggregation`)
  still hold. If painful, heatmap mode can be feature-flagged/deferred.
- **`react-map-gl/maplibre`** — verify the v8 entrypoint + `<Map>` API
  (`mapStyle`, `reuseMaps`, ref handle), and the raster `@2x` tile style +
  `attributionControl={false}` under maplibre 5.
- **`ColumnLayer` (`StackedHexLayer.tsx`)** — verify `diskResolution`,
  `getElevation`, `extruded`, `material:false`, and especially the
  stacked-segment trick (base-Z encoded as `position[2]`) still composes under
  the new renderer.
- **TypeScript** — deck.gl 9 types are stricter; layer generic params
  (`ColumnLayer<Segment>` etc.) and accessor return types may need touch-ups.

### 3. Files likely touched

`www/package.json`, `www/src/map/CrashMap.tsx`, `www/src/map/StackedHexLayer.tsx`,
the lockfile, and possibly `vite.config.ts` (maplibre 5 `optimizeDeps`).

### 4. Verify

- **Unit:** `www/src/map/v2.test.ts`, `h3cover.test.ts` (pure — run anyway).
- **e2e:** `www/e2e/map-perf.spec.ts`, `perf-har.spec.ts`.
- **Manual / CIC:** all three modes — hexbin (3D), scatter, heatmap — on the
  `/map` route, the `CrashMapSection` embed on Home, and `/map/hudson/legacy`.
  Check basemap tiles, pitch/drag-rotate, hex column extrusion + severity
  stacking, tooltips, pitch slider, attribution popover, light/dark themes.
- **Perf:** deck.gl 9 changed the renderer — spot-check FPS on a dense
  viewport.

### 5. Then — adopt `@rdub/deck-map`

Once on deck.gl 9:

- Replace `www/src/map/hooks/useTouchPitch.ts` with the package's
  `useTouchPitch` (the two were byte-identical). crashes' `CrashMap` uses a
  `useState`-style `setLocalViewState`, so it's directly compatible with the
  hook's `Dispatch<SetStateAction<V>>` setter.
- Replace the hand-rolled `rasterStyle()` with `stadiaRasterStyle()`.
- Wire via [`pds`] — `pds init` the local `~/c/js/deck-map` for local dev, or
  `pds gh` once that package has a published dist branch.

## Risks / notes

- Keep deck.gl + react-map-gl + maplibre moving together — they're coupled.
- `HeatmapLayer` is the biggest unknown; isolate it so the rest of the upgrade
  isn't blocked on it.

[`@rdub/deck-map`]: https://github.com/runsascoded/deck-map
[deck.gl upgrade guide]: https://deck.gl/docs/upgrade-guide
[`pds`]: https://github.com/runsascoded/pnpm-dep-source
