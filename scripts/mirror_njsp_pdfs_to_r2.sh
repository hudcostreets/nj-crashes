#!/bin/bash
# Mirror NJSP fatal-crash annual-summary PDFs to R2 `raw/njsp/`.
#
# Source: `njsp/data/annual-summaries/*.pdf` — primary-source PDFs from
# nj.gov/njsp/info/fatalacc/pdf/. Two reports per year:
#   - ptccr_YY.pdf  (Preliminary Total Crash Count Report)
#   - swfcs2_YY.pdf (Statewide Fatal Crash Summary)
#
# Target: r2://nj-crashes/raw/njsp/data/annual-summaries/*.pdf
# (path mirrors the repo so the file browser shows them at
#  /raw/njsp/data/annual-summaries/.)
#
# Companion to:
#   - scripts/mirror_bulk_to_r2.py  (NJDOT zips/pqts via DVX cache)
#   - scripts/mirror_fields_to_r2.sh  (NJDOT column-spec sidecars)
#   - scripts/mirror_raw_readmes_to_r2.sh  (per-dir README sidecars)
#
# Idempotent via aws s3 sync's size+mtime check.

set -euo pipefail

PROFILE="${AWS_PROFILE_R2:-cf}"
ENDPOINT="${R2_ENDPOINT:-https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-nj-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

AWS_PROFILE="$PROFILE" aws s3 sync \
  njsp/data/annual-summaries/ \
  "s3://$BUCKET/${PREFIX}njsp/data/annual-summaries/" \
  --endpoint-url "$ENDPOINT" \
  --exclude '*' \
  --include '*.pdf' \
  --content-type 'application/pdf' \
  "$@"
