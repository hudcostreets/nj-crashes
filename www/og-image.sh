#!/usr/bin/env bash
set -euo pipefail

# Generate the homepage OG mosaic (Plot1 + Recent Fatal Crashes table)
# and upload to s3://nj-crashes/og.jpg. SE-only DVX stage — no local
# artifact tracked. The site's <meta og:image> points at the S3 URL,
# so each daily run overwrites in place.
#
# Called from `og-image.dvc` (and runnable manually via `./og-image.sh`).

cd "$(dirname "$0")"

# Playwright browsers (CI runners are fresh each time; local: no-op if
# already installed).
npx playwright install chromium >&2

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
JPG="$TMPDIR/og.jpg"

OG_OUT_PATH="$JPG" npx playwright test e2e/og-screenshot.spec.ts --reporter=list

aws s3 cp "$JPG" s3://nj-crashes/og.jpg \
    --content-type image/jpeg \
    --cache-control "public, max-age=300"

echo "Uploaded $(wc -c < "$JPG") bytes to s3://nj-crashes/og.jpg" >&2
