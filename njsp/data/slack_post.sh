#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Find all "Refresh NJSP data" commits in the last 7 days
# Pass them all to slack sync — it's idempotent (skips already-posted)
refresh_shas=$(git log --format=%H --grep="Refresh NJSP data" --since="7 days ago")
if [ -z "$refresh_shas" ]; then
    echo "No recent 'Refresh NJSP data' commits found, skipping Slack post" >&2
    exit 0
fi

args=""
for sha in $refresh_shas; do
    args="$args -r $sha"
done

echo "Posting Slack updates for refresh commits: $refresh_shas"
njsp slack sync -l njsp/data/crash-log.parquet $args

# Signal DVX to commit
if [ -n "${DVX_COMMIT_MSG_FILE:-}" ]; then
    echo "Post crash updates to Slack" > "$DVX_COMMIT_MSG_FILE"
fi
