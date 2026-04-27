#!/usr/bin/env bash
# Kill any existing Vite servers on the project's port range and start a
# fresh `pnpm dev` (or `pnpm preview`) wired to the S3 map shards.
#
# Usage: ./dev-restart.sh [dev|preview] [extra pnpm args...]
#   default mode: dev
#
# Allow-list this script so the dev-server bounce doesn't need a fresh
# permission prompt every time.

set -euo pipefail

cd "$(dirname "$0")"

MODE="${1:-dev}"; shift || true

# Standard project port + nearby fallbacks Vite picks when the primary is busy.
PORTS=(4006 4007 4008 4009)

for p in "${PORTS[@]}"; do
    pids=$(lsof -i ":$p" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "Killing pid(s) on :$p — $pids"
        kill $pids 2>/dev/null || true
    fi
done
sleep 1

export VITE_MAP_BASE_URL="${VITE_MAP_BASE_URL:-https://nj-crashes.s3.amazonaws.com/njdot/map}"
export VITE_API_URL="${VITE_API_URL:-https://crashes-api.ryan-0dc.workers.dev}"
echo "Starting pnpm $MODE (VITE_MAP_BASE_URL=$VITE_MAP_BASE_URL  VITE_API_URL=$VITE_API_URL)"
exec pnpm "$MODE" "$@"
