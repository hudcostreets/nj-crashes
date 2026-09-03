#!/bin/sh
# Fargate entrypoint: run dvx, then push the regenerated `.dvc`s back as ONE
# commit.
#
# Why one commit at the end (not `dvx run --commit --push each`): the reproc
# runs the whole DAG with level-parallelism, so per-stage `git commit`/`git
# push` race — concurrent pushes to the results branch get "cannot lock ref …
# is at X but expected Y" and the losing stages' commits never escape. Instead
# we run dvx with `--no-commit` (it still *writes* the updated `.dvc` md5s into
# the worktree — it just doesn't commit them), and after the parallel run
# finishes we `git add -u && commit && push` once. No concurrency, no races,
# and the whole regenerated `.dvc` set lands as a single reviewable commit.
#
# Token arrives as $FARGATE_GITHUB_RW_TOKEN (AWS Batch injects it from Secrets
# Manager); absent it, we run read-only. Targets: Batch caps containerOverrides
# at 8192 bytes and the ~160-path list nears that, so the submit command is
# flags-only and we append `batch/reproc-targets` here.
set -e

# Audit mode: run the reproducibility audit instead of a reproc. No git
# push-back, no dvx orchestration — `reproc-audit` pins each stage's committed
# deps and re-runs its cmd itself, then classifies produced-vs-baseline. Used
# to characterize determinism / x86-vs-arm64 arch-invariance of the daily
# stages (see specs discussion). Invoked as `audit [targets...]`.
if [ "${1:-}" = audit ]; then
    shift
    cd /app
    exec batch/reproc-audit "$@"
fi

push_back=no
if [ -n "${FARGATE_GITHUB_RW_TOKEN:-}" ]; then
    git -C /app remote set-url --push origin \
        "https://x-access-token:${FARGATE_GITHUB_RW_TOKEN}@github.com/hudcostreets/nj-crashes.git"
    branch="${RESULTS_BRANCH:-reproc-results/$(date -u +%Y%m%d-%H%M%S)}"
    git -C /app checkout -B "$branch"
    push_back=yes
    echo "entrypoint: will commit+push regenerated .dvc to origin/$branch after the run" >&2
else
    echo "entrypoint: no FARGATE_GITHUB_RW_TOKEN set; no git push-back" >&2
fi

# Append the reproc target set to a `run` that names no explicit .dvc targets.
is_run=no; has_target=no; has_mem=no
for a in "$@"; do
    [ "$a" = run ] && is_run=yes
    case "$a" in
        *.dvc) has_target=yes;;
        -m|--mem) has_mem=yes;;
    esac
done
if [ "$is_run" = yes ] && [ "$has_target" = no ]; then
    # shellcheck disable=SC2046
    set -- "$@" $(cd /app && batch/reproc-targets)
    echo "entrypoint: appended $(cd /app && batch/reproc-targets | wc -l | tr -d ' ') reproc targets" >&2
fi

# For a `run` with no explicit -m/--mem, inject a level memory budget = 85% of
# the container's RAM (leaving headroom for unlabeled medium stages) so heavy
# labeled stages (`meta.computation.resources.mem_gb`) serialize while light
# ones stay parallel. Auto-adapts to whatever memory Pulumi provisions for the
# job, so a re-tiered box needs no code change. This is the durable fix for the
# from-scratch-reproc OOM (16-way level parallelism co-ran the 30-40 GB `.db`
# builds); `-j` stays at CPU count. Insert right after the `run` token so the
# variadic target list can't swallow the value.
if [ "$is_run" = yes ] && [ "$has_mem" = no ]; then
    mem_total_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
    if [ "${mem_total_kb:-0}" -gt 0 ]; then
        mem_budget=$(( mem_total_kb * 85 / 100 / 1024 / 1024 ))
        new=""
        for a in "$@"; do
            new="$new $a"
            [ "$a" = run ] && new="$new -m $mem_budget"
        done
        # shellcheck disable=SC2086
        set -- $new
        echo "entrypoint: injected -m $mem_budget GB (85% of $((mem_total_kb / 1024 / 1024)) GB RAM)" >&2
    fi
fi

# Run dvx WITHOUT exec so we can commit+push after it returns.
set +e
dvx "$@"
rc=$?
set -e

if [ "$push_back" = yes ]; then
    cd /app
    git add -u
    if git diff --cached --quiet; then
        echo "entrypoint: no .dvc changes — nothing to push (fully reproducible)" >&2
    else
        n=$(git diff --cached --name-only | wc -l | tr -d ' ')
        git commit -q -m "reproc results: $n .dvc regenerated @ $(date -u +%FT%TZ)" \
            -m "From-scratch \`dvx run --no-commit -f\` in batch/entrypoint.sh; one atomic commit to dodge per-stage push races."
        if git push -u origin HEAD 2>&1; then
            echo "entrypoint: pushed $n regenerated .dvc to origin/$branch" >&2
        else
            echo "entrypoint: FINAL PUSH FAILED" >&2
            [ "$rc" -eq 0 ] && rc=1
        fi
    fi
fi
exit "$rc"
