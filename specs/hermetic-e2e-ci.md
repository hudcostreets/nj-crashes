# Hermetic e2e in CI — local `api` + `cells-api`

## Motivation

`.github/workflows/ci.yml` (added alongside this spec) runs the fast checks
(typecheck, build, `vitest`, `pytest`) plus **one** e2e spec — `legend-ux` —
on every code push. `legend-ux` is hermetic: it exercises the homepage
*plots*, which read static parquet from `www/public/njsp/*.parquet` (served by
the www server itself), so it needs no backend.

The other e2e specs are **not** hermetic — they hit Cloudflare Workers:

- `crash-detail.spec.ts` → `api` worker (D1) — the NJDOT crash table + the
  `/crash/:year/:cc/:mc/:case` detail endpoint.
- `map-perf.spec.ts`, `perf-har.spec.ts` (map scenarios) → `cells-api` worker
  (R2) — the H3 hex pyramid.

Running those against the *deployed* prod workers would couple CI health to
prod uptime + leak CI traffic into prod. The goal here: run both workers
**locally** in CI, with the www pointed at them — fully hermetic.

## What's needed

### 1. Run the workers locally — *easy*
`wrangler dev` runs each Worker locally (miniflare; `--local` uses on-disk
SQLite for D1 + a local R2). A couple of background steps in the workflow.

### 2. Point the www at them — *easy*
Both base URLs are already env-overridable:
- `www/src/api.ts`: `API_BASE = import.meta.env.VITE_API_URL ?? "/api"`.
- `www/src/map/config.ts`: `CELLS_API_BASE` (confirm it reads an env var; add
  one if not — 1-line change).

Run the e2e job with `VITE_API_URL` / the cells-api env pointed at the local
`wrangler dev` ports.

### 3. Seed the workers' data stores — *the real work*

A fresh `wrangler dev --local` worker has **empty** D1 / R2.

- **`api` → D1.** Needs the crash tables (`crashes`, `vehicles`, `occupants`,
  `pedestrians`, `cmymc`, `njsp-crashes`). Full prod data is 6.57M NJDOT rows
  — too slow to import per-run. `api/scripts/d1-import.sh` exists but targets
  *remote* D1; a `--local` path (`wrangler d1 execute --local`) is needed.
- **`cells-api` → R2.** Needs the ~127 MB H3 pyramid seeded into the local R2
  (miniflare on-disk state), or a viewport-scoped subset.

## Recommended approach — a small committed fixture

Build a **fixture dataset scoped to one county** — Hudson (`cc=09`), since
`crash-detail.spec.ts` already navigates `/c/hudson/jersey-city`:

- A `fixture` CLI subcommand (e.g. `njdot fixture --county Hudson`) that
  filters the full parquets/D1 to Hudson and emits a small SQLite + a small
  R2-pyramid subset.
- DVC-track the fixture (small — a few MB) so CI pulls it fast and
  deterministically, instead of filtering 6.5M rows every run.
- e2e specs that depend on it assert against fixture-scoped data (they
  already use Hudson/Jersey City).

This keeps CI fast, deterministic, and offline-from-prod.

## Steps

1. Add a `VITE`/env override for `CELLS_API_BASE` if it doesn't have one.
2. `njdot fixture` (or similar) — emit the Hudson-scoped D1 SQLite + R2 subset;
   DVC-track the outputs.
3. `api/scripts/d1-import.sh` — add a `--local` mode (seed miniflare D1).
4. CI `e2e-api` job: `dvx pull` the fixture → seed local D1/R2 → `wrangler dev`
   both workers (background) → `playwright test` the API-dependent specs with
   the env pointed local.
5. Fold `crash-detail`, `map-perf`, and `perf-har` map scenarios into that job.

## Open questions

- Fixture as a committed/DVC-tracked artifact vs. built fresh each CI run —
  lean committed (fast, deterministic).
- `perf-har` golden byte-counts are tuned against prod responses; a fixture
  changes payload sizes, so its goldens would need regenerating against the
  fixture (or `perf-har` stays a separate prod-targeted nightly job).
- Whether to also run the workers' own unit tests (`cells-api` has h3 bit-math
  tests) in CI — cheap, worth adding to `ci.yml` independently of this.

## Out of scope
- Seeding the *full* dataset — the fixture is deliberately a subset.
- `perf-har` against prod — if kept, that's a separate nightly job, not part
  of the hermetic push-CI.
