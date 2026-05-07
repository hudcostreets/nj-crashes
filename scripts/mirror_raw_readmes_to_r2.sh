#!/bin/bash
# Mirror per-directory README.md sidecars to R2 `raw/` so the file
# browser can render them above each directory listing.
#
# Source layout mirrors R2 layout exactly:
#   data/raw-readmes/README.md            → r2://nj-crashes/raw/README.md
#   data/raw-readmes/njdot/data/README.md → r2://nj-crashes/raw/njdot/data/README.md
#   ...
#
# Companion to scripts/mirror_bulk_to_r2.py and mirror_fields_to_r2.sh.
# Idempotent via aws s3 sync's size+mtime check.

set -euo pipefail

PROFILE="${AWS_PROFILE_R2:-cf}"
ENDPOINT="${R2_ENDPOINT:-https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-nj-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

AWS_PROFILE="$PROFILE" aws s3 sync \
  data/raw-readmes/ \
  "s3://$BUCKET/${PREFIX}" \
  --endpoint-url "$ENDPOINT" \
  --content-type 'text/markdown; charset=utf-8' \
  "$@"
