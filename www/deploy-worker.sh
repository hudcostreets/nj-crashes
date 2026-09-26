#!/usr/bin/env bash
# Build + deploy the FE as a Worker with static Assets (W+A; see `wrangler.toml`).
#   ./deploy-worker.sh        prod: `crashes-www` → prod workers
#   ./deploy-worker.sh dev    dev:  `crashes-www-dev` → `*-dev` workers (prod data)
# Not yet wired into CI: `deploy.dvc` still runs `./deploy.sh` (Pages) until the
# domain cutover (`specs/workers-assets-and-map-ogi.md`).
#
# Creds: `CF_HCCS_INFRA_TOKEN` (GH secret in CI, `.envrc` locally), or run under
# `python3 ../infra/hccs-run ./deploy-worker.sh dev`.
set -euo pipefail

HCCS_ACCOUNT=2363642879f18d37d52dca114059937e

tier="${1:-prod}"
case "$tier" in
    prod) api=crashes-api     cells=crashes-cells     env_args=() ;;
    dev)  api=crashes-api-dev cells=crashes-cells-dev env_args=(--env dev) ;;
    *) echo "usage: $0 [prod|dev]" >&2; exit 1 ;;
esac

if [ -n "${CF_HCCS_INFRA_TOKEN:-}" ]; then
    export CLOUDFLARE_API_TOKEN="$CF_HCCS_INFRA_TOKEN"
    export CLOUDFLARE_ACCOUNT_ID="$HCCS_ACCOUNT"
elif [ "${CLOUDFLARE_ACCOUNT_ID:-}" != "$HCCS_ACCOUNT" ]; then
    echo "CF_HCCS_INFRA_TOKEN unset and not under infra/hccs-run — refusing to deploy to a non-HCCS account" >&2
    exit 1
fi

VITE_API_URL="https://$api.hccs.dev" \
VITE_CELLS_API_BASE="https://$cells.hccs.dev" \
VITE_MAP_BASE_URL=https://crashes-data.hccs.dev/njdot/map \
    pnpm build
# No `404.html` copy: `not_found_handling = "single-page-application"` serves
# `index.html` for unknown paths.
cp worker/_headers dist/_headers
find dist -name '*.db' -o -name '*.db.bak' | xargs rm -f
# Map shards are served from R2 (VITE_MAP_BASE_URL=crashes-data.hccs.dev); never
# ship them with the FE.
rm -rf dist/njdot/map
find dist -size +25M -delete
npx wrangler deploy ${env_args[@]+"${env_args[@]}"}
