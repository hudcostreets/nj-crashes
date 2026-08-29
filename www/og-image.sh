#!/usr/bin/env bash
set -euo pipefail

# Generate the homepage OG mosaic (Plot1 + Recent Fatal Crashes table)
# and upload to $NJC_S3/og.jpg. SE-only DVX stage — no local
# artifact tracked. The site's <meta og:image> points at the S3 URL,
# so each daily run overwrites in place.
#
# Called from `og-image.dvc` (and runnable manually via `./og-image.sh`).

cd "$(dirname "$0")"

# Playwright browsers (CI runners are fresh each time; local: no-op if
# already installed).
npx playwright install chromium >&2

# Point the embedded dev server at the prod CF worker so its `/njsp/*`
# fetches resolve. Without this, vite's dev proxy targets
# `localhost:51894` (wrangler dev) which isn't running in CI; the page
# errors and `og-screenshot.spec.ts` refuses to publish.
export VITE_API_URL="${VITE_API_URL:-https://crashes-api.ryan-0dc.workers.dev}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
JPG="$TMPDIR/og.jpg"

# Mirrors `nj_crashes.paths.S3`; override to publish somewhere other than
# prod (e.g. a full-DAG reproc audit).
S3_ROOT="${NJC_S3:-s3://nj-crashes}"

OG_OUT_PATH="$JPG" npx playwright test e2e/og-screenshot.spec.ts --reporter=list

aws s3 cp "$JPG" "$S3_ROOT/og.jpg" \
    --content-type image/jpeg \
    --cache-control "public, max-age=300"

echo "Uploaded $(wc -c < "$JPG") bytes to $S3_ROOT/og.jpg" >&2
