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

### Implemented (2026-09-26, branch `workers-assets`)

- `www/wrangler.toml`: `crashes-www` (prod, **not deployed**) + `[env.dev]` → `crashes-www-dev`. `compatibility_date = "2025-04-01"`, `[assets] directory = "./dist"`, `binding = "ASSETS"`, `not_found_handling = "single-page-application"`. Bindings `NJSP_CRASHES_DB` (HCCS D1 `njsp-crashes`) + `OG_BUCKET` (HCCS R2 `crashes`), repeated under `[env.dev]`; unused by the current OG logic (as in the middleware), reserved for per-page OG images.
- `run_worker_first` is an explicit list of SPA routes: `/`, `/c`, `/c/*`, `/crash/*`, `/map`, `/map/*`, `/raw`, `/raw/*`, `/sql`. `/assets/*`, data files (`/njsp/*.parquet`, …) and the remaining SPA paths (`/:muniSlug`, `/tune`, …) go to the asset server directly; those SPA paths get the built `index.html`, whose meta already equals the default OG meta (and for non-navigation requests such as crawler fetches, unmatched paths reach the Worker anyway). Extend the list when a route gains route-specific OG (e.g. map OG images below already fall under `/map*`).
- `www/worker/index.ts`: the `_middleware.ts` port. `env.ASSETS.fetch(request)`, then the same `resolveOgMeta` + `HTMLRewriter` rewrites on `text/html` responses; everything else passes through. Own `worker/tsconfig.json` (`@cloudflare/workers-types`; `npx tsc -p worker/tsconfig.json`).
- `www/worker/_headers` (copied into `dist/` by the W+A deploy only): `/assets/*` → `Cache-Control: public, max-age=31536000, immutable` (W+A's default is `max-age=0, must-revalidate`; Pages served `max-age=14400`).
- `www/deploy-worker.sh [prod|dev]`: same build + `VITE_*` per tier as `deploy.sh`, no `404.html` copy, then `wrangler deploy [--env dev]`. Creds: `CF_HCCS_INFRA_TOKEN` (CI / `.envrc`), or run under `python3 ../infra/hccs-run ./deploy-worker.sh dev`; refuses to run against a non-HCCS account.
- `www/package.json`: `wrangler` + `@cloudflare/workers-types` devDeps (so `npx wrangler` in both deploy scripts now resolves to the pinned local wrangler rather than a fresh download). `www/deploy.sh` (Pages) is unchanged and is still what `deploy.dvc` runs; `wrangler pages deploy` ignores `www/wrangler.toml` (no `pages_build_output_dir`) with a warning.

### Validated (dev only)

`crashes-www-dev` deployed → <https://crashes-www-dev.hccs-ctbk.workers.dev>. curl vs the Pages dev site (`dev.crashes.hccs.dev`), comparing `<title>` + all `og:*` / `twitter:*` tags:

| Path | Pages | W+A | OG tags |
|---|---|---|---|
| `/` | 200 | 200 | same |
| `/map` | 404 | 200 | same |
| `/c/hudson` | 404 | 200 | same (Hudson County) |
| `/c/hudson/jersey-city` | 404 | 200 | same (Jersey City, Hudson County) |
| `/crash/2023/2/17/23-20410` | 404 | 200 | same (default) |
| `/crash/123` | 404 | 200 | same (Fatal Crash) |
| `/sql` | 404 | 200 | same |
| `/raw/njdot/data/2023` | 404 | 200 | same |
| `/jersey-city` | 404 | 200 | same |
| `/nonexistent-xyz/abc` | 404 | 200 | same |

- Pages served every non-root SPA route with **status 404** (the `404.html` copy of `index.html`); W+A returns 200. Crawlers generally unfurl either, but 200 is correct.
- `wrangler tail` confirmed the Worker ran only for the `run_worker_first` routes; `/assets/index-*.js`, `/njsp/monthly.parquet`, `/og.png` and `/jersey-city` (navigation) were served without invoking it. Hashed assets: 200 + `public, max-age=31536000, immutable`.
- Minor header diffs: `.parquet` has no `content-type` on W+A (Pages: `application/octet-stream`); JS is `text/javascript` (Pages: `application/javascript`). Neither serves byte ranges (parity). DuckDB-WASM plots render.
- CIC (HCCS profile): `/map` and `/c/hudson` render (map, plots); API calls go to `crashes-api-dev` / `crashes-cells-dev` / `crashes-data`. Stadia basemap tiles 401 on `*.workers.dev` (Stadia's domain allowlist; same tiles 200 with a `dev.crashes.hccs.dev` referer), so the basemap only appears once the Worker has an allowlisted hostname.

### Remaining cutover steps

1. **Dev domain**: add `'dev.crashes.hccs.dev': 'crashes-www-dev'` to `infra/` `WORKER_DOMAINS` (+ `deployed_workers`), remove the domain from the `crashes-dev` Pages project, `infra/pul up`. Expect a ~2 min gap (a hostname can only be active on one of Pages / Worker). Note `dev.crashes.hccs.dev` is two labels deep: Pages issued its own cert for it; check a Workers Custom Domain gets one too (Custom Domains issue per-hostname certs, so it should), before relying on it.
2. Verify dev on its real hostname (OG curl sweep above, basemap tiles, CIC), a few days.
3. **Switch deploys**: `deploy.dvc` → `./deploy-worker.sh` (and update its `git_deps`: `deploy-worker.sh`, `wrangler.toml`, `worker`, drop `functions`); or fold `deploy-worker.sh` into `deploy.sh`. CI already has `CF_HCCS_INFRA_TOKEN` (the same token deployed `crashes-www-dev` here, so it has Workers Scripts Edit). Deploy `crashes-www` (prod) once before the domain move.
4. **Prod domains**: `crashes.hccs.dev` + `crashes.hudcostreets.org` → `crashes-www` (same `WORKER_DOMAINS` flow). `crashes.hudcostreets.org` is a Squarespace-DNS CNAME to `crashes.pages.dev`, not a CF zone, so it can't be a Workers Custom Domain directly: it needs either a CF for SaaS custom hostname on `hccs.dev` or a re-CNAME to a hostname the Worker serves (decide before cutover; the Pages project could also keep serving it for a while). Stadia allowlist unaffected (same hostnames).
5. Retire the `crashes` / `crashes-dev` Pages projects and `www/functions/` after green days.

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
