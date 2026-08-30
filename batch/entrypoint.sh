#!/bin/sh
# Fargate entrypoint: wire git push-back + supply the reproc target set, then
# hand off to dvx.
#
# Push-back: `dvx run --commit --push each` commits each regenerated stage's
# `.dvc` and then `git push`es it (executor.py: `git add -u` + `git commit`,
# then a commit-gated `git push`). Two things the image alone can't provide:
#   1. an auth'd push remote — the image clones the public read-only URL;
#   2. a real branch — `git checkout $REF` leaves a detached HEAD, and
#      `git push` from detached HEAD fails ("not currently on a branch").
# Both are set here at *runtime* so the token never lands in an image layer.
#
# Targets: AWS Batch caps `containerOverrides` at 8192 bytes, and the reproc
# target list (~160 `.dvc` paths) alone approaches that — no room left for the
# token/branch env overrides. So the submit command carries only flags, and we
# append `batch/reproc-targets` here (computed in-container). A `run` that
# already names explicit `.dvc` targets is left untouched.
set -e
if [ -n "${FARGATE_GITHUB_RW_TOKEN:-}" ]; then
    git -C /app remote set-url --push origin \
        "https://x-access-token:${FARGATE_GITHUB_RW_TOKEN}@github.com/hudcostreets/nj-crashes.git"
    git -C /app config push.autoSetupRemote true
    branch="${RESULTS_BRANCH:-reproc-results/$(date -u +%Y%m%d-%H%M%S)}"
    git -C /app checkout -B "$branch"
    echo "entrypoint: regenerated-.dvc commits will push to origin/$branch" >&2
else
    echo "entrypoint: no FARGATE_GITHUB_RW_TOKEN set; no git push-back" >&2
fi

# Append the reproc target set to a `run` that has no explicit .dvc targets.
is_run=no; has_target=no
for a in "$@"; do
    [ "$a" = run ] && is_run=yes
    case "$a" in *.dvc) has_target=yes;; esac
done
if [ "$is_run" = yes ] && [ "$has_target" = no ]; then
    # shellcheck disable=SC2046
    set -- "$@" $(cd /app && batch/reproc-targets)
    echo "entrypoint: appended $(cd /app && batch/reproc-targets | wc -l | tr -d ' ') reproc targets" >&2
fi
exec dvx "$@"
