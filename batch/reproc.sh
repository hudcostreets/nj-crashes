#!/usr/bin/env bash
# Reproc driver (specs/batch-reproc.md): run the repo's data DAG,
# excluding side-effect stages (deploys, imports, notifications, and
# fetch stages that mutate tracked inputs).
#
# Usage:
#   batch/reproc.sh                  # run all data targets (incremental)
#   batch/reproc.sh -f               # from-scratch: force re-run derived stages
#   batch/reproc.sh <target.dvc>...  # explicit targets (exclusions still apply)
# Extra args (-j N, --push each, --dry-run, ...) pass through to `dvx run`.
#
# Leaves (raw zips/XMLs/PDFs) are cmd-less `.dvc`s: `dvx run` can only
# pull them, never re-download — reproc regenerates *derived* targets
# against pinned raw inputs by construction.
set -euo pipefail
cd "$(dirname "$0")/.."

# Side-effect / outward / input-mutating stages. Structurally these are
# the outs-less `.dvc`s (`grep -L '^outs:'`), minus the three that are
# pure data stages whose outputs are tracked by sibling `.dvc`s
# (harmonize, projections) or that we exclude anyway for fetching
# (refresh, summaries).
EXCLUDES=(
    api/d1-import.dvc        # writes prod D1
    cells-api/deploy.dvc     # deploys the worker
    www/deploy.dvc           # deploys the site
    www/og-image.dvc         # pushes to S3 + reads deployed site
    njsp/data/slack_post.dvc # posts to Slack
    njsp/data/refresh.dvc    # fetches + mutates tracked NJSP XMLs
    njsp/data/summaries.dvc  # fetches NJSP annual-report PDFs
    www/public/njdot/map_sync.dvc  # syncs to S3
)

is_excluded() {
    local t="$1"
    for e in "${EXCLUDES[@]}"; do [[ "$t" == "$e" ]] && return 0; done
    return 1
}

targets=()
args=()
for a in "$@"; do
    if [[ "$a" == *.dvc ]]; then targets+=("$a"); else args+=("$a"); fi
done
if [[ ${#targets[@]} -eq 0 ]]; then
    while IFS= read -r t; do
        is_excluded "$t" || targets+=("$t")
    done < <(git ls-files '*.dvc')
else
    kept=()
    for t in "${targets[@]}"; do
        if is_excluded "$t"; then echo "skipping excluded side-effect target: $t" >&2
        else kept+=("$t"); fi
    done
    targets=("${kept[@]}")
fi

echo "reproc: ${#targets[@]} targets" >&2
exec dvx run --commit never "${args[@]}" "${targets[@]}"
