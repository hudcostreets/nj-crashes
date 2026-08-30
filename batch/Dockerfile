# Full-DAG reproc image (specs/batch-reproc.md).
#
# Self-contained for now: python + uv + a shallow clone of this repo +
# `uv sync`. Once dvx publishes its `dvx-batch` base image
# (`~/c/dvx/specs/batch-executor.md` §1), this becomes
# `FROM dvx-batch:<rev>` + the clone + sync.
#
# The clone (not COPY) keeps the build context tiny and gives dvx the
# `.git` objects it needs for `git_deps` hashing. `--filter=blob:none`
# (blobless partial clone) rather than `--depth 1`: `njsp crash_log compute`
# walks the git history of `data/FAUQStats*.xml` (1,348 commits back to the
# 2022-05-25 root), which a shallow clone doesn't have — it then falls back to
# per-commit GitHub API fetches, needing a token and ~1.3k round trips.
# Measured: blobless = 60 MB in 3.2s with full history and blobs fetched
# lazily (and batched) on demand; a full clone is 3.71 GiB. Build arg `REF`
# pins the rev.
#
# Build (arm64, for Graviton Fargate):
#   docker build --platform linux/arm64 -t nj-crashes-reproc:$(git rev-parse --short HEAD) \
#     --build-arg REF=$(git rev-parse HEAD) batch/
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG REPO=https://github.com/hudcostreets/nj-crashes
ARG REF=main
RUN git clone --filter=blob:none "$REPO" /app && git -C /app checkout "$REF"
WORKDIR /app

# Flat venv (the multi-version `.venv/<ver>/` layout is a direnv-ism;
# containers want the plain shape).
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONFAULTHANDLER=1

# Container-local git identity: `dvx run --commit` (the per-stage cache-
# flush workaround, see dvx `specs/batch-run-command-cli-mismatch.md`)
# needs `git commit` to succeed; the commits die with the container.
RUN git config --global user.name "dvx-batch" && \
    git config --global user.email "dvx-batch@localhost"

# Push-back entrypoint: `git push`es dvx's per-stage `.dvc` commits when
# $FARGATE_GITHUB_RW_TOKEN is present (see batch/entrypoint.sh), else runs
# read-only. It `exec dvx "$@"`, so the submitted command stays `["run", ...]`
# (`dvx batch submit` builds it). Full-DAG runs pass targets at submit time:
#   dvx batch submit $(batch/reproc-targets)
# Copied to / (not /app) so the repo clone can't shadow it.
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
