# Branch consolidation / rollout (2026-10-20)

`ready-20261020` rebases the map/roads/feedback stack from `map-mode-heatmap-on-cells` onto `h/main` at `3435f7d56b3`, preserving current daily data and adaptive DVX materialization. Original branch refs and worktrees remain unchanged. The independent `duckdb-up` version/config upgrade is included; its superseded road-query changes are not.

## Branch inventory

- Included: map heatmap/render/performance branches, roads v3–v5.1 and road notes/search/UI, crash-location recovery, recovered cells, immutable cells, per-year D1 cells, Batch cells promotion, feedback, and `deps-security`.
- `road-data-research`: its source survey is already included with subsequent factual corrections; do not overwrite those with the older survey.
- `pr5`: the abbreviated municipality-name fix and expanded tests already exist; no additional patch is needed.
- Held: `bump-thrds-0.5.0`'s old dependency bump, `audit`'s synthetic historical metadata, and the remaining historical metadata change on `fix/victim-count-pk-join`. These are not prerequisites for this rollout and need separate relevance/compatibility review.
- Held: `worktree-agent-a9a898ef981a9a996` aggregation/property-column prototype. Historical backup, server, and old frontend branches are not rollout candidates.

## Infrastructure checkpoint boundary

The Cloudflare Pulumi checkpoint under `infra/state/` is byte-identical to current main. Main contains newer SaaS/custom-domain resources absent from the old feedback checkpoint, while the feedback checkpoint contains resources absent from main. Do not replace one snapshot with the other, concatenate resource arrays, or run `pulumi up` against this incomplete inventory.

Read-only checks confirm the existing `crashes-feedback` D1 database (`63f0723a-56c5-4969-bd9c-a787ab6ebd1e`), `feedback` table/indexes, `crashes-feedback` R2 bucket, and production `SLACK_FEEDBACK_WEBHOOK` / `TURNSTILE_SECRET` secret names. No secret values were retrieved. `FEEDBACK_ADMIN_TOKEN` is absent, so administrative listing remains disabled by design.

Before a future infrastructure update, reconcile the existing feedback R2, D1, and Turnstile resources using supported Pulumi import/refresh procedures, review a preview for zero unintended replacements/deletions, and commit the resulting checkpoint. That state-mutating operation requires specific approval; the automatic safety review rejected manually merging production checkpoint JSON. No such merge is retained.

## Release gates / order

1. Push the integration branch and pass CI, including the root Python feature tests and cells worker suite added during consolidation.
2. Validate both worker bundles and their existing bindings; deploy/test the dev APIs before production APIs, then deploy the frontend against the corresponding APIs. Do not rerun bulk data backfills or cells promotion merely to release code.
3. Verify homepage plots, map rendering / road selection, road detail, and feedback in the intended Chrome profile before the production frontend release. The local Chrome bridge currently cannot initialize because its Browser plugin runtime module is missing; automated Playwright checks do not substitute for this outstanding CIC gate.
4. Fast-forward main only after release gates pass; re-fetch first because the daily workflow advances it. Watch CI and any dispatched deployment with `ghws` / `ghwr -W`.

Local verification: Python 212 passed / 1 skipped; frontend unit tests 324 passed / 18 skipped; cells worker 107 passed / 10 skipped; API 36 passed. Frontend typecheck/build passes. Feedback body-limit regressions failed against the old implementation and pass with bounded actual-body reads, including absent or misleading Content-Length headers.
