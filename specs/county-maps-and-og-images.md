# County Maps and og:images

Generate static map images for each county to use as `og:image` on county pages, and improve the site-wide og:image.

## Context

- 21 NJ counties, each will have a page at `/c/:county`
- Current site og:image is a static plot PNG (`fatalities_per_year_by_type.png`)
- `Head` component in `www/src/lib/head.tsx` handles og:image meta tags
- Existing spec `og-image-and-favicon.md` covers site-level og:image dimensions (1200x630) and favicon upgrade

## County og:images

### Requirements
- One image per county: `www/public/og/c/<county-slug>.png`
- Dimensions: 1200x630 (standard og:image ratio)
- Content: Map of the county showing crash locations, with county name overlaid
  - Background: county boundary filled, surrounding area dimmed
  - Dots: crash locations colored by severity (red = fatal, orange = injury)
  - Text: county name, crash count, year range
- Keep under 300KB each

### Generation Approach
- Use a headless browser (Playwright) or static map tile renderer
- Options:
  1. **Playwright screenshot of the CrashMap component** — most consistent with site appearance, but requires a running dev server or SSR
  2. **Python script with matplotlib/cartopy** — standalone, no browser needed, but different visual style
  3. **MapLibre/Mapbox static API** — simple, but may have API limits
  4. **[`scrns`]** — screenshot automation tool already in the toolchain (see CLAUDE.md)
- Recommendation: Use `scrns` to screenshot the county map pages once they're built, with a specific viewport size matching 1200x630

### Integration
- `CrashRegion.tsx` passes county-specific og:image to `Head`:
  ```tsx
  <Head
    title={title}
    description={`Crash data for ${location}`}
    url={`${siteUrl}/c/${countySlug}`}
    image={`/og/c/${countySlug}.png`}
  />
  ```
- Fallback to site-wide og:image if county image doesn't exist

## Municipality og:images

Lower priority — 565 municipalities is a lot of images. Options:
- Generate on-demand (first request triggers generation + caching)
- Skip for now, use county og:image as fallback for municipality pages
- Generate only for municipalities above some crash count threshold

## Site-wide og:image

Per existing `og-image-and-favicon.md`:
- Resize to 1200x630
- Use `scrns` to screenshot the home page hero plot at correct dimensions
- Update `Head` default image path

## Implementation Order
1. Fix site-wide og:image dimensions (from existing spec)
2. Build county pages first (see `county-city-pages.md`)
3. Generate county og:images via `scrns` screenshots
4. Wire county og:images into `CrashRegion.tsx` `Head` component

[`scrns`]: https://www.npmjs.com/package/scrns
