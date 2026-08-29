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
# The target list comes from `batch/reproc-targets`, which derives the
# exclusions from each stage's `meta.computation.side_effect` flag — see
# that script for why the set is what it is. Both entry points share it so
# there's one definition of "in scope", not two that drift.
#
# Leaves (raw zips/XMLs/PDFs) are cmd-less `.dvc`s: `dvx run` can only
# pull them, never re-download — reproc regenerates *derived* targets
# against pinned raw inputs by construction.
set -euo pipefail
cd "$(dirname "$0")/.."

mapfile -t in_scope < <(batch/reproc-targets)

is_excluded() {
    local t="$1"
    for e in "${in_scope[@]}"; do [[ "$t" == "$e" ]] && return 1; done
    return 0
}

targets=()
args=()
for a in "$@"; do
    if [[ "$a" == *.dvc ]]; then targets+=("$a"); else args+=("$a"); fi
done
if [[ ${#targets[@]} -eq 0 ]]; then
    targets=("${in_scope[@]}")
else
    kept=()
    for t in "${targets[@]}"; do
        if is_excluded "$t"; then echo "skipping excluded side-effect target: $t" >&2
        else kept+=("$t"); fi
    done
    targets=("${kept[@]}")
fi

echo "reproc: ${#targets[@]} targets" >&2
exec dvx run --no-commit "${args[@]}" "${targets[@]}"
