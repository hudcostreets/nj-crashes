# FE on Workers + Assets; dynamic OG images for map views

## Status quo

- The FE is a **Pages** project per tier (`crashes` → `crashes.hccs.dev` + `crashes.hudcostreets.org`; `crashes-dev` → `dev.crashes.hccs.dev`), direct-uploaded by `www/deploy.sh [prod|dev]`.
- `www/functions/_middleware.ts` (a Pages Function) rewrites `<meta og:*>` per route (`/c/:county/:muni`, …). Every route's `og:image` is the same daily-regenerated homepage mosaic (`crashes-data.hccs.dev/og.jpg`, from `www/og-image.dvc`).
- Map views (`/map…?mode=&hr=&llz=&yr=…`) share links well (all view state is in the URL), but unfurl with the generic mosaic, not the view being shared.

## Goals

1. **Workers + static Assets ("W+A")** instead of Pages: one Worker per tier serving the SPA from `assets`, with the OG logic as ordinary Worker code. This is Cloudflare's forward path (new features land on Workers, not Pages) and matches the direction of other projects.
2. **Dynamic OG images for map views**: `og:image` for a `/map…` URL is a render of *that* view (mode, heatmap strategy, camera, year range, severities, county/muni scope).

## 1. W+A migration

- `www/wrangler.toml`: `name = "crashes-www"` (+ `[env.dev]` → `crashes-www-dev`), `main = "worker/index.ts"`, `[assets] directory = "./dist"`, `not_found_handling = "single-page-application"` (replaces the `404.html` copy), `run_worker_first = true` for HTML routes only (so the Worker can rewrite OG meta; hashed assets skip the Worker).
- Port `_middleware.ts` → `worker/index.ts`: `env.ASSETS.fetch(request)` for the SPA shell, then `HTMLRewriter` for the OG tags (same `resolveOgMeta` logic). Bindings as before (`NJSP_CRASHES_DB`, `OG_BUCKET`).
- Custom domains move from the Pages projects to the Workers (`infra/` `WORKER_DOMAINS`; Pulumi, like the API workers). The cutover has the same "hostname can only be active on one thing" gap as the 2026-09-13 Pages move (~2 min); do dev first, then prod.
- `www/deploy.sh [prod|dev]` → `wrangler deploy [--env dev]`. `deploy.dvc` keeps calling it. Preview deploys are replaced by `wrangler versions upload` (preview URLs per version) if still wanted.
- Retire the `crashes` / `crashes-dev` Pages projects after green days.

## 2. Map OG images

- **Route:** `GET /og/map.png?<the map's own query params>` on the W+A Worker. `og:image` for `/map…` pages points at it with the page's (normalized) params.
- **Render:** Cloudflare **Browser Rendering** (`@cloudflare/puppeteer`, `[browser]` binding) loads the page itself at 1200×630 in a render mode (e.g. `?og=1`: no chrome/toolbox/omnibar, fixed camera, waits for a "map idle" signal from deck.gl/maplibre, as the e2e OG screenshot spec already does), screenshots it, and returns a JPEG.
- **Cache:** R2 `crashes` under `og/map/<hash(normalized params + data_version + build id)>.jpg`, plus the edge cache. Crawlers hit the same few shared links, so renders are rare. `data_version` (cells manifest) in the key means a data update re-renders instead of serving a stale view.
- **Normalization:** canonicalize params (sort, drop UI-only ones like debug/toolbox, round `llz`) so near-identical links share one cached image. Unknown or invalid params → the generic mosaic.
- **Fallback:** if a render fails or times out (crawlers wait ~5s), 302 to the static mosaic and render in the background (`ctx.waitUntil`) so the next fetch is warm.
- **Cost/limits:** Browser Rendering is metered by browser-seconds on Workers Paid (HCCS is on Paid); cached renders keep it small. Rate-limit per IP to avoid render-farming.

## Open questions

- Also render OG images for the `/c/:county/:muni` pages (a scoped map, or the plots)? Same machinery.
- `hudcostreets.org` stays a second hostname on the prod Worker (as now on Pages)?
