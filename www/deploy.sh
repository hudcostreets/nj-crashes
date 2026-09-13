#!/usr/bin/env bash
set -euo pipefail

VITE_API_URL=https://crashes-api.ryan-0dc.workers.dev \
VITE_CELLS_API_BASE=https://crashes-cells.hccs.dev \
VITE_MAP_BASE_URL=https://crashes-data.hccs.dev/njdot/map \
    pnpm build
cp dist/index.html dist/404.html
find dist -name '*.db' -o -name '*.db.bak' | xargs rm -f
# Map shards are served from R2 (VITE_MAP_BASE_URL=crashes-data.hccs.dev); never
# ship them with the CFP deploy.
rm -rf dist/njdot/map
find dist -size +25M -delete
# HCCS crashes — serves both crashes.hccs.dev and crashes.hudcostreets.org (the
# latter moved off RAC nj-crashes on 2026-09-13, so this is the sole deploy now).
# CF_HCCS_INFRA_TOKEN: GH secret in CI, .envrc locally — required.
if [ -z "${CF_HCCS_INFRA_TOKEN:-}" ]; then
    echo "CF_HCCS_INFRA_TOKEN unset — cannot deploy to HCCS crashes Pages" >&2
    exit 1
fi
CLOUDFLARE_API_TOKEN="$CF_HCCS_INFRA_TOKEN" CLOUDFLARE_ACCOUNT_ID=2363642879f18d37d52dca114059937e \
    npx wrangler pages deploy dist --project-name crashes --commit-dirty=true

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Deploy www to CF Pages" > "$DVX_COMMIT_MSG_FILE"
fi
