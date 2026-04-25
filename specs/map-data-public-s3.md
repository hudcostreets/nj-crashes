# Serve map shards from public S3 instead of bundling into CFP

## Status: not started (2026-04-25)

## Motivation

The map-data bundle (`www/public/njdot/map/`) is now ~250 MB across
596 sharded parquet + geojson files (after `map-pipeline-pdo-and-top-route`
landed). Today the CFP deploy flow assumes everything in `www/public/`
ships with the site. That makes deploys slow and bloats every CFP
version, even though map data changes annually (NJDOT) while the rest
of the site changes daily.

`hyparquet` only needs HTTP range requests for column projection,
which S3 supports natively. There's no functional reason the shards
have to ride along with the JS bundle.

## Current state (verified 2026-04-25)

- Bucket `s3://nj-crashes/` is already public-read (bucket policy
  allows `s3:GetObject` for `*`; `IsPublic: true`).
- CORS already configured: `*` origin, `GET`+`HEAD`, exposes
  `Accept-Ranges` + `Content-Range`. Range-request fetches return
  `206 Partial Content`.
- Prefix `s3://nj-crashes/njdot/map/` is currently empty — clean
  landing spot that mirrors the in-app URL path.
- Daily CI does **not** `dvx pull www/public/njdot/map`, so the
  bundle has never been deployed to CFP. The `/map` route is
  effectively local-dev-only today (404s on prod).
- `deploy.sh` has a `find dist -size +25M -delete` line — implicit
  acknowledgement that big assets don't belong in the CFP deploy.

## Plan

### 1. Sync map shards to public S3

Add a sync step that runs after `dvx run www/public/njdot/map.dvc`:

```bash
aws s3 sync www/public/njdot/map s3://nj-crashes/njdot/map --delete
```

- Idempotent: `sync` only re-uploads changed files (size + mtime).
- `--delete` removes shards that no longer exist in the source (e.g.
  if a year is dropped). Since map data is annual, this is safe.
- Runs from EC2 (where `dvx run` happens) or wherever the rerun
  occurs. Not part of the daily CI loop — daily NJSP refreshes don't
  affect map data, so daily runs would no-op the sync.
- `Content-Type` headers: `aws s3 sync` infers from extension —
  `.parquet` → `application/octet-stream`, `.json` → `application/json`,
  `.geojson` → `application/geo+json`. All fine.
- `Cache-Control`: not set initially (browsers will refetch on each
  page load). If repeat-visit cost matters, add
  `--cache-control "public, max-age=86400"` later.

### 2. Frontend wire-in

`useCrashData.ts` builds URLs like `/njdot/map/<shard>.parquet`. Add
a single base URL constant fed by an env var:

```ts
// www/src/map/config.ts (new)
export const MAP_BASE_URL = (import.meta.env.VITE_MAP_BASE_URL ?? "/njdot/map").replace(/\/$/, "")
```

- Local dev: env var unset → `/njdot/map` → Vite serves `public/`
  directly. No change to dev flow.
- Prod: build with `VITE_MAP_BASE_URL=https://nj-crashes.s3.amazonaws.com/njdot/map`.

Replace path constructions in:
- `www/src/map/useCrashData.ts` — `MANIFEST_PATH`, `shardPathsForFilter`
- `www/src/map/CrashMap.tsx` — county/muni outline fetches (if any)
- `www/src/routes/CrashMapPage.tsx` / `CrashMapSection.tsx` — outline fetches

Search for the literal `/njdot/map` and route everything through
`MAP_BASE_URL` (template literal: `${MAP_BASE_URL}/manifest.json`).

### 3. Strip from CFP deploy

In `deploy.sh`, before the wrangler push:

```bash
rm -rf dist/njdot/map
```

Belt-and-suspenders: even if a future CI flow accidentally pulls map
data into `public/`, it doesn't ship with CFP. Vite serves `public/`
in dev unchanged — this only affects the production `dist/` output.

### 4. Set the build env var

- Local: `.env.local` adds `VITE_MAP_BASE_URL` only when previewing
  a prod-shape build (otherwise omit; dev uses `public/` fallback).
- CI: `.github/workflows/daily.yml` exports `VITE_MAP_BASE_URL` for
  the `Deploy www to CF Pages` step (or set it in `deploy.sh`).
- The deploy.sh already sets `VITE_API_URL` inline — same pattern:

```bash
VITE_API_URL=... \
VITE_MAP_BASE_URL=https://nj-crashes.s3.amazonaws.com/njdot/map \
  pnpm build
```

### 5. Initial sync

After the spec lands, run the sync once to populate
`s3://nj-crashes/njdot/map/`:

```bash
aws s3 sync www/public/njdot/map s3://nj-crashes/njdot/map --delete
```

Smoke test by hitting
`https://nj-crashes.s3.amazonaws.com/njdot/map/manifest.json` from
the browser. Then deploy with `VITE_MAP_BASE_URL` pointed at it and
verify `/c/hudson/jersey-city#map` loads shards from S3.

## Files touched

- `specs/done/map-data-public-s3.md` (this spec, when done)
- `www/src/map/config.ts` (new)
- `www/src/map/useCrashData.ts`
- `www/src/map/CrashMap.tsx` (if it builds shard URLs)
- `www/src/routes/CrashMapPage.tsx`
- `www/src/routes/CrashMapSection.tsx`
- `www/deploy.sh`
- One-off: run `aws s3 sync ...` from local (no committed change)

## Out of scope (graduate later)

- Custom domain (e.g. `map.crashes.hudcostreets.org`). Cosmetic; can
  be added by pointing CloudFront/CFW at the bucket without changing
  the frontend (just the env var).
- CloudFront in front of the bucket. Worth doing if egress costs
  show up; today they won't.
- R2 instead of S3. Same data model. R2's pitch is zero egress; S3
  egress on this volume is also negligible.
- Cloudflare Worker proxy. Adds value for auth, header rewriting, or
  request shaping — none needed for read-only public shards.
- `Cache-Control` tuning. Browsers refetch on each load today; if
  repeat-visit perf matters, add long max-age (shards are
  content-addressed-ish via filename — when they change, the
  manifest changes and clients refetch).

## Verification

- `https://nj-crashes.s3.amazonaws.com/njdot/map/manifest.json` returns
  `200` with valid JSON.
- Range request: `curl -H "Range: bytes=0-99"
  https://nj-crashes.s3.amazonaws.com/njdot/map/hex-r7/2023.parquet`
  returns `206 Partial Content`.
- After deploy: `/c/hudson/jersey-city#map` loads (network tab shows
  parquet fetches against S3, not CFP).
- After deploy: `dist/` size shrinks back to roughly pre-map-bundle
  baseline (was ~25 MB-ish before the bundle landed).
