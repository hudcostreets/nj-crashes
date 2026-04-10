#!/usr/bin/env bash
set -euo pipefail

VITE_API_URL=https://crashes-api.ryan-0dc.workers.dev pnpm build
cp dist/index.html dist/404.html
find dist -name '*.db' -o -name '*.db.bak' | xargs rm -f
find dist -size +25M -delete
npx wrangler pages deploy dist --project-name nj-crashes --commit-dirty=true

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Deploy www to CF Pages" > "$DVX_COMMIT_MSG_FILE"
fi
