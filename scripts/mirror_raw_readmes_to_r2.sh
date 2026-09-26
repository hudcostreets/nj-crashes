#!/bin/bash
# Mirror per-directory README.md sidecars to R2 `raw/` so the file
# browser can render them above each directory listing.
#
# READMEs live at their natural repo paths (mirroring the layout
# under `raw/` 1:1):
#
#   njdot/data/README.md                  → r2://crashes/raw/njdot/data/README.md
#   njdot/data/<year>/README.md           → r2://crashes/raw/njdot/data/<year>/README.md
#   njsp/data/annual-summaries/README.md  → r2://crashes/raw/njsp/data/annual-summaries/README.md
#
# The list is hard-coded rather than discovered by `find` so we don't
# accidentally mirror unrelated READMEs (e.g. njsp/cli/README.md).
#
# Companion to scripts/mirror_bulk_to_r2.py and mirror_fields_to_r2.sh.
# Idempotent via `aws s3 cp`'s ETag check.

set -euo pipefail

# Creds: env (run under `infra/r2-run`), or a named profile via AWS_PROFILE_R2.
PROFILE="${AWS_PROFILE_R2:-}"
ENDPOINT="${R2_ENDPOINT:-https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-crashes}"
PREFIX="${R2_PREFIX:-raw/}"

READMES=(
    njdot/data/README.md
    njdot/data/2022/README.md
    njdot/data/2023/README.md
    njdot/data/2024/README.md
    njdot/data/2025/README.md
    njsp/data/annual-summaries/README.md
)

for readme in "${READMES[@]}"; do
    if [[ ! -f "$readme" ]]; then
        echo "SKIP $readme (not present)" >&2
        continue
    fi
    aws ${PROFILE:+--profile "$PROFILE"} s3 cp \
        "$readme" \
        "s3://$BUCKET/${PREFIX}$readme" \
        --endpoint-url "$ENDPOINT" \
        --content-type 'text/markdown; charset=utf-8' \
        "$@"
done
