# Cloudflare Worker for per-page OG + crash detail pages

## Problem

Social preview crawlers (Facebook, Twitter, Slack, Discord) don't execute JavaScript. The SPA serves the same `index.html` for all routes, so every page shows the same og:title/og:description/og:image regardless of whether it's statewide, a county, a municipality, or an individual crash.

## Architecture

### Cloudflare Worker (HTML rewriter)

A CF Worker sits in front of GitHub Pages. For most requests, it passes through to the origin. For crawler requests (detected by user-agent) OR for `<head>` tag rewriting on all requests:

```
Request → CF Worker → Is it a page request (not asset)?
                      ├─ Yes → Fetch origin HTML
                      │        Rewrite <meta> tags based on URL path
                      │        Return modified HTML
                      └─ No  → Pass through to origin
```

The Worker parses the URL path and injects route-specific OG tags:

| Route | og:title | og:image |
|-------|----------|----------|
| `/` | NJ Car Crash Data | `/og.png` (statewide) |
| `/c/hudson` | Hudson County — NJ Car Crash Data | `/og/c/hudson.png` |
| `/c/hudson/jersey-city` | Jersey City, Hudson County — NJ Car Crash Data | `/og/c/hudson/jersey-city.png` |
| `/crash/12345` | Fatal crash: Jersey City, Jan 15 2024 — NJ Car Crash Data | `/og/crash/12345.png` |

The Worker can also set og:description with crash-specific details (date, location, casualties) by querying the D1 API.

### OG metadata sources

**Geographic pages** (`/`, `/c/:county`, `/c/:county/:muni`):
- Title: derived from URL path (county/muni name lookup from `cc2mc2mn.json`, cached in Worker)
- Description: "Car crash data for {region}, NJ" or statewide default
- Image: pre-generated screenshots stored in R2

**Crash detail pages** (`/crash/:accid`):
- Title: "Fatal crash: {municipality}, {date}" 
- Description: "{N} casualties on {road} — {county} County, NJ"
- Image: either a map screenshot centered on crash location, or a template with crash details overlaid
- Data: fetched from D1 API (`/njsp/crashes?accid=:accid`)

### Implementation

```ts
// CF Worker (simplified)
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    
    // Pass through assets
    if (url.pathname.match(/\.(js|css|png|json|ico|woff|parquet)$/)) {
      return fetch(request)
    }
    
    // Fetch origin HTML
    const response = await fetch(`${env.ORIGIN}${url.pathname}`)
    const ogMeta = await resolveOgMeta(url.pathname, env)
    
    // Rewrite <head> with route-specific OG tags
    return new HTMLRewriter()
      .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', ogMeta.title) } })
      .on('meta[property="og:description"]', { element(el) { el.setAttribute('content', ogMeta.description) } })
      .on('meta[property="og:image"]', { element(el) { el.setAttribute('content', ogMeta.image) } })
      .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', ogMeta.url) } })
      .on('meta[name="twitter:image"]', { element(el) { el.setAttribute('content', ogMeta.image) } })
      .on('title', { element(el) { el.setInnerContent(ogMeta.title) } })
      .transform(response)
  }
}

async function resolveOgMeta(pathname: string, env: Env): Promise<OgMeta> {
  // /c/:county/:muni
  const geoMatch = pathname.match(/^\/c\/([^/]+)(?:\/([^/]+))?$/)
  if (geoMatch) {
    const [, countySlug, muniSlug] = geoMatch
    const county = denormalize(countySlug)
    const muni = muniSlug ? denormalize(muniSlug) : null
    const region = muni ? `${muni}, ${county} County` : `${county} County`
    return {
      title: `${region} — NJ Car Crash Data`,
      description: `Car crash data for ${region}, NJ`,
      image: `${env.OG_BASE}/og/c/${countySlug}${muniSlug ? `/${muniSlug}` : ''}.png`,
      url: `https://crashes.hudcostreets.org${pathname}`,
    }
  }
  
  // /crash/:accid
  const crashMatch = pathname.match(/^\/crash\/(\d+)$/)
  if (crashMatch) {
    const accid = crashMatch[1]
    // Fetch crash details from D1
    const crash = await env.D1.prepare('SELECT * FROM crashes WHERE accid = ?').bind(accid).first()
    if (crash) {
      return {
        title: `Fatal crash: ${crash.municipality}, ${crash.date} — NJ Car Crash Data`,
        description: `${crash.casualties} on ${crash.location} — ${crash.county} County, NJ`,
        image: `${env.OG_BASE}/og/crash/${accid}.png`,
        url: `https://crashes.hudcostreets.org/crash/${accid}`,
      }
    }
  }
  
  // Default (statewide)
  return {
    title: 'NJ Car Crash Data',
    description: 'Analysis & Visualization of car crash data published by NJ State Police and NJ DOT',
    image: `https://crashes.hudcostreets.org/og.png`,
    url: `https://crashes.hudcostreets.org`,
  }
}
```

## OG image generation pipeline

### Statewide OGI (daily)

Already implemented: `/og` page + `e2e/og-screenshot.spec.ts` generates `public/og.png`.

Move to CI:
1. Daily pipeline starts preview server
2. Playwright screenshots `/og`
3. Upload to R2 at `og/statewide.png`
4. Static `index.html` references R2 URL

### Per-county OGI (daily or on-demand)

The `/og` page could accept query params: `/og?cc=9` renders Hudson County plots.
Or create `/og/c/:county` routes that render county-specific versions.

Screenshot each county (21 images) in the daily pipeline and upload to R2.

### Per-muni OGI (on-demand)

565 municipalities — too many for daily generation. Options:
1. **On-demand via CF Worker**: Worker receives request for `/og/c/hudson/jersey-city.png`, checks R2 cache, if missing → triggers generation (via queue or generates inline with lightweight template)
2. **Lazy generation**: first request triggers async generation, returns a fallback (county OGI or statewide) until the muni-specific one is ready
3. **Build-time for top N**: pre-generate for municipalities with >50 crashes, on-demand for the rest

### Per-crash OGI (on-demand)

10K+ crashes — must be on-demand. Options:
1. **Template-based**: CF Worker generates a simple image from crash data (map tile + text overlay). Libraries like `@cloudflare/pages-plugin-satori` or `satori` can generate SVG→PNG from JSX.
2. **Playwright-based**: Too slow for on-demand. Could work as async generation with R2 caching.
3. **Static template**: HTML canvas rendered server-side with crash location map + details.

Recommend satori for per-crash OGIs — it generates images from JSX without a browser, fast enough for on-demand use in a CF Worker.

## Crash detail pages

### Route: `/crash/:accid`

New SPA route showing detailed information for a single crash:
- Date, time, location (with map)
- Casualties (victim types, injuries, fatalities)
- Vehicles involved
- Road/intersection details
- Link to county/muni pages
- Previous versions (if crash data was updated)

Data source: D1 API (`/njsp/crashes?accid=:accid` for NJSP, or NJDOT crash details)

### Navigation from tables

The "Recent Fatal Crashes" table and "Crash Details (NJ DOT)" table would link each row to `/crash/:accid`. Currently municipality names are links; crash rows would also become links.

## Implementation order

1. **CF Worker for OG tag rewriting** (geo pages only, use existing statewide OGI as fallback)
2. **Daily OGI to R2** (statewide, move from committed file to R2)
3. **Per-county OGI generation** (21 screenshots in daily pipeline → R2)
4. **CF Worker serves per-county OGI** (from R2)
5. **Crash detail page** (SPA route + D1 query)
6. **Per-crash OG metadata** (CF Worker + D1 query for title/description)
7. **Per-crash OGI** (satori template in CF Worker, R2 cached)
8. **Per-muni OGI** (on-demand generation, R2 cached)

## Existing infrastructure

- CF Worker: `crashes-api` already exists at `crashes-api.ryan-0dc.workers.dev`
- D1 database: `njsp-crashes` table has all crash data
- R2: can create a bucket for OG images
- GitHub Pages: current origin for static assets
- Playwright: already configured for screenshots
