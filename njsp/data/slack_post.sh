#!/usr/bin/env bash
set -euo pipefail

# Find the most recent "Refresh NJSP data" commit
refresh_sha=$(git log --format=%H --grep="Refresh NJSP data" -1)
if [ -z "$refresh_sha" ]; then
    echo "No 'Refresh NJSP data' commit found, skipping Slack post" >&2
    exit 0
fi

echo "Posting Slack updates for refresh commit: $refresh_sha"
cd "$(git rev-parse --show-toplevel)"
njsp slack sync -r "$refresh_sha"

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Post crash updates to Slack" > "$DVX_COMMIT_MSG_FILE"
fi
