# Full-DAG reproc image (specs/batch-reproc.md).
#
# Self-contained for now: python + uv + a shallow clone of this repo +
# `uv sync`. Once dvx publishes its `dvx-batch` base image
# (`~/c/dvx/specs/batch-executor.md` §1), this becomes
# `FROM dvx-batch:<rev>` + the clone + sync.
#
# The clone (not COPY) keeps the build context tiny and gives dvx the
# `.git` objects it needs for `git_deps` hashing — `--depth 1` suffices
# (blobs at HEAD are what get hashed). Build arg `REF` pins the rev.
#
# Build (arm64, for Graviton Fargate):
#   docker build --platform linux/arm64 -t nj-crashes-reproc:$(git rev-parse --short HEAD) \
#     --build-arg REF=$(git rev-parse HEAD) batch/
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG REPO=https://github.com/hudcostreets/nj-crashes
ARG REF=main
RUN git clone --depth 1 --revision "$REF" "$REPO" /app || \
    (git clone --depth 1 "$REPO" /app && git -C /app fetch --depth 1 origin "$REF" && git -C /app checkout FETCH_HEAD)
WORKDIR /app

# Flat venv (the multi-version `.venv/<ver>/` layout is a direnv-ism;
# containers want the plain shape).
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONFAULTHANDLER=1

ENTRYPOINT ["batch/reproc.sh"]
