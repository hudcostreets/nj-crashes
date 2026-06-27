#!/usr/bin/env bash
# Post a CI-failure summary to Slack channel `$SLACK_CI_CHANNEL_ID`.
#
# Wired into `.github/workflows/daily.yml` as the final step under
# `if: failure()`. Pure-bash so it still runs even when the failure is in
# Python / dependency-install steps before `.venv/bin` is on PATH.
#
# Required env (set by the GHA shell automatically unless noted):
#   GITHUB_RUN_ID        — for `gh run view` lookup of the failed step
#   GITHUB_SHA           — commit SHA
#   GITHUB_REF_NAME      — branch
#   GITHUB_SERVER_URL    — e.g. https://github.com
#   GITHUB_REPOSITORY    — owner/repo
#   GH_TOKEN             — must be passed in step env (gh CLI auth)
#   EVENT_NAME           — caller-set; the workflow's event (schedule / workflow_dispatch / …)
#   SLACK_BOT_TOKEN, SLACK_CI_CHANNEL_ID
#                        — Slack post target; if either is unset the script
#                          prints the would-be message and exits 0 so the
#                          underlying CI failure remains the loud signal.
#
# Slack post failures are logged as a `::warning::` GHA annotation rather
# than re-raising — the pipeline already failed and we don't want a notify
# bug to mask the real cause.

set -euo pipefail

run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

failed_step=$(gh run view "${GITHUB_RUN_ID}" --json jobs \
    --jq '.jobs[].steps[] | select(.conclusion == "failure") | .name' \
    | head -1)
failed_step="${failed_step:-unknown step}"
short_sha="${GITHUB_SHA:0:7}"
commit_subject=$(git log -1 --format=%s "${GITHUB_SHA}" 2>/dev/null || echo '(unavailable)')

text=":x: *Daily pipeline failed* at \`${failed_step}\` (\`${GITHUB_REF_NAME}\` ${short_sha} _${commit_subject}_, event=${EVENT_NAME:-?})"$'\n'"<${run_url}|view run>"

if [[ -z "${SLACK_CI_CHANNEL_ID:-}" || -z "${SLACK_BOT_TOKEN:-}" ]]; then
    echo "SLACK_CI_CHANNEL_ID or SLACK_BOT_TOKEN unset; would-be message:"
    printf '%s\n' "$text"
    exit 0
fi

payload=$(jq -nc \
    --arg channel "${SLACK_CI_CHANNEL_ID}" \
    --arg text "$text" \
    '{channel: $channel, text: $text, unfurl_links: false, unfurl_media: false}')

resp=$(curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H 'Content-Type: application/json; charset=utf-8' \
    -d "$payload")
echo "Slack response: $resp"

ok=$(printf '%s' "$resp" | jq -r '.ok // false')
if [[ "$ok" != "true" ]]; then
    echo "::warning::Slack CI notification failed: $resp"
fi
