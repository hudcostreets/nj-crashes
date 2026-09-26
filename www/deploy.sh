#!/usr/bin/env bash
# Build + deploy the FE to HCCS Pages.
#   ./deploy.sh        prod: `crashes` (crashes.hccs.dev, crashes.hudcostreets.org) → prod workers
#   ./deploy.sh dev    dev:  `crashes-dev` (dev.crashes.hccs.dev) → `*-dev` workers (prod data)
set -euo pipefail

tier="${1:-prod}"
case "$tier" in
    # prod: Pages takes the branch from git, so a non-`main` checkout only makes a
    # preview deploy (a guard against shipping a feature branch to prod).
    prod) project=crashes     api=crashes-api     cells=crashes-cells     branch_args=() ;;
    # dev: whatever branch is checked out goes live at dev.crashes.hccs.dev.
    dev)  project=crashes-dev api=crashes-api-dev cells=crashes-cells-dev branch_args=(--branch main) ;;
    *) echo "usage: $0 [prod|dev]" >&2; exit 1 ;;
esac

VITE_API_URL="https://$api.hccs.dev" \
VITE_CELLS_API_BASE="https://$cells.hccs.dev" \
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
    npx wrangler pages deploy dist --project-name "$project" --commit-dirty=true ${branch_args[@]+"${branch_args[@]}"}

# Signal DVX to commit
if [ "$tier" = prod ] && [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Deploy www to CF Pages" > "$DVX_COMMIT_MSG_FILE"
fi
