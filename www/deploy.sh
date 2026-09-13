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
# RAC nj-crashes (live prod via crashes.hudcostreets.org) — dropped once
# hudcostreets re-CNAMEs to HCCS.
npx wrangler pages deploy dist --project-name nj-crashes --commit-dirty=true
# HCCS crashes (crashes.hccs.dev). CF_HCCS_INFRA_TOKEN: GH secret in CI, .envrc locally.
CLOUDFLARE_API_TOKEN="$CF_HCCS_INFRA_TOKEN" CLOUDFLARE_ACCOUNT_ID=2363642879f18d37d52dca114059937e \
    npx wrangler pages deploy dist --project-name crashes --commit-dirty=true

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Deploy www to CF Pages" > "$DVX_COMMIT_MSG_FILE"
fi
