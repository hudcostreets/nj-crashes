#!/bin/bash
# Mirror NJDOT field-schema sidecars (JSON + PDF) to R2.
#
# Companion to scripts/mirror_bulk_to_r2.py. The bulk script handles
# `.dvc`-tracked artifacts (zips/pqts in njdot/data/<year>/); this one
# uploads the git-tracked schema files in njdot/data/fields/. Idempotent
# via aws s3 sync's size+mtime check.
#
# Outputs land at r2://nj-crashes/raw/njdot/data/fields/{2001,2017}*.{json,pdf}
# so the /raw file browser can render them alongside the year tarballs.

set -euo pipefail

PROFILE="${AWS_PROFILE_R2:-cf}"
ENDPOINT="${R2_ENDPOINT:-https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-nj-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

AWS_PROFILE="$PROFILE" aws s3 sync \
  njdot/data/fields/ \
  "s3://$BUCKET/${PREFIX}njdot/data/fields/" \
  --endpoint-url "$ENDPOINT" \
  --exclude '*.tabula-template.json' \
  "$@"
