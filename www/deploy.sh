#!/usr/bin/env bash
set -euo pipefail

VITE_API_URL=https://crashes-api.ryan-0dc.workers.dev \
VITE_CELLS_API_BASE=https://crashes-cells-api.ryan-0dc.workers.dev \
VITE_MAP_BASE_URL=https://nj-crashes.s3.amazonaws.com/njdot/map \
    pnpm build
cp dist/index.html dist/404.html
find dist -name '*.db' -o -name '*.db.bak' | xargs rm -f
# Map shards are served from S3 (see VITE_MAP_BASE_URL above); never ship them
# with the CFP deploy.
rm -rf dist/njdot/map
find dist -size +25M -delete
npx wrangler pages deploy dist --project-name nj-crashes --commit-dirty=true

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Deploy www to CF Pages" > "$DVX_COMMIT_MSG_FILE"
fi
