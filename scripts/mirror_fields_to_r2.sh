#!/bin/bash
# Mirror NJDOT field-schema sidecars (JSON + PDF) to R2.
#
# Companion to scripts/mirror_bulk_to_r2.py. The bulk script handles
# `.dvc`-tracked artifacts (zips/pqts in njdot/data/<year>/); this one
# uploads the git-tracked schema files in njdot/data/fields/. Idempotent
# via aws s3 sync's size+mtime check.
#
# Outputs land at r2://crashes/raw/njdot/data/fields/{2001,2017}*.{json,pdf}
# so the /raw file browser can render them alongside the year tarballs.

set -euo pipefail

# Creds: env (run under `infra/r2-run`), or a named profile via AWS_PROFILE_R2.
PROFILE="${AWS_PROFILE_R2:-}"
ENDPOINT="${R2_ENDPOINT:-https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

aws ${PROFILE:+--profile "$PROFILE"} s3 sync \
  njdot/data/fields/ \
  "s3://$BUCKET/${PREFIX}njdot/data/fields/" \
  --endpoint-url "$ENDPOINT" \
  --exclude '*.tabula-template.json' \
  "$@"
