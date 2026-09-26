#!/bin/bash
# Mirror NJSP fatal-crash annual-summary PDFs to R2 `raw/njsp/`.
#
# Source: `njsp/data/annual-summaries/*.pdf` — primary-source PDFs from
# nj.gov/njsp/info/fatalacc/pdf/. Two reports per year:
#   - ptccr_YY.pdf  (Preliminary Total Crash Count Report)
#   - swfcs2_YY.pdf (Statewide Fatal Crash Summary)
#
# Target: r2://crashes/raw/njsp/data/annual-summaries/*.pdf
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

# Creds: env (run under `infra/r2-run`), or a named profile via AWS_PROFILE_R2.
PROFILE="${AWS_PROFILE_R2:-}"
ENDPOINT="${R2_ENDPOINT:-https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

aws ${PROFILE:+--profile "$PROFILE"} s3 sync \
  njsp/data/annual-summaries/ \
  "s3://$BUCKET/${PREFIX}njsp/data/annual-summaries/" \
  --endpoint-url "$ENDPOINT" \
  --exclude '*' \
  --include '*.pdf' \
  --content-type 'application/pdf' \
  "$@"
