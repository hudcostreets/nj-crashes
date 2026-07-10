#!/usr/bin/env python3
"""Nightly probe of Cloudflare Workers Analytics for `crashes-cells-api` errors.

Queries the `workersInvocationsAdaptive` GraphQL dataset for the last 24h,
groups by `status`, and posts a summary to Slack ONLY if any non-success
status appears with `errors > 0`. Silence when clean — the daily flow
already surfaces success; this exists to catch memory/runtime failures
that pass CI (they happen at request time, not deploy time).

Env:
    CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — required
    SLACK_BOT_TOKEN, SLACK_CI_CHANNEL_ID       — post target
    WORKER_SCRIPT_NAME                         — default: crashes-cells-api
    LOOKBACK_HOURS                             — default: 24

Non-zero exit on API failures (probe itself broke); exit 0 on both the
"clean" case and the "posted-alert" case (the alert IS the signal).
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone


def die(msg: str, code: int = 1) -> None:
    print(f"cf-worker-errors: {msg}", file=sys.stderr)
    sys.exit(code)


def cf_query(token: str, acct: str, script: str, lookback_h: int) -> list[dict]:
    end = datetime.now(timezone.utc).replace(microsecond=0, minute=0, second=0)
    start = end - timedelta(hours=lookback_h)
    query = """
    query WorkerStatusesLast($acct: String!, $start: Time!, $end: Time!, $script: string) {
      viewer {
        accounts(filter: { accountTag: $acct }) {
          workersInvocationsAdaptive(
            limit: 1000
            filter: { datetime_geq: $start, datetime_lt: $end, scriptName: $script }
          ) {
            sum { requests errors }
            dimensions { status }
          }
        }
      }
    }
    """
    payload = json.dumps({
        "query": query,
        "variables": {
            "acct": acct,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "script": script,
        },
    }).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read())
    except urllib.error.URLError as e:
        die(f"CF GraphQL request failed: {e}")
    if body.get("errors"):
        die(f"CF GraphQL returned errors: {body['errors']}")
    accounts = body["data"]["viewer"]["accounts"]
    return accounts[0]["workersInvocationsAdaptive"] if accounts else []


def slack_post(token: str, channel: str, text: str) -> None:
    payload = json.dumps({
        "channel": channel,
        "text": text,
        "unfurl_links": False,
        "unfurl_media": False,
    }).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if not resp.get("ok"):
        die(f"Slack post failed: {resp}")


def main() -> None:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    acct  = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not acct:
        die("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID unset")
    script     = os.environ.get("WORKER_SCRIPT_NAME", "crashes-cells-api")
    lookback_h = int(os.environ.get("LOOKBACK_HOURS", "24"))

    rows = cf_query(token, acct, script, lookback_h)
    by_status: dict[str, tuple[int, int]] = {}
    for row in rows:
        st   = row["dimensions"]["status"]
        reqs = row["sum"]["requests"]
        errs = row["sum"]["errors"]
        prev = by_status.get(st, (0, 0))
        by_status[st] = (prev[0] + reqs, prev[1] + errs)

    total_errs = sum(e for _, e in by_status.values())
    total_reqs = sum(r for r, _ in by_status.values())
    print(f"[{script}] last {lookback_h}h: {total_reqs} reqs, {total_errs} errs")
    for st, (r, e) in sorted(by_status.items()):
        print(f"  {st:<24} {r:>6} reqs / {e:>4} errs")

    if total_errs == 0:
        print("clean — no post")
        return

    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    channel     = os.environ.get("SLACK_CI_CHANNEL_ID")
    if not slack_token or not channel:
        die("SLACK_BOT_TOKEN / SLACK_CI_CHANNEL_ID unset but errors present", code=2)

    lines = [f":warning: *`{script}`* — {total_errs} errors in last {lookback_h}h ({total_reqs} reqs total)"]
    for st, (r, e) in sorted(by_status.items(), key=lambda kv: (-kv[1][1], kv[0])):
        if e > 0:
            lines.append(f"• `{st}` — {e} / {r}")
    lines.append("<https://dash.cloudflare.com/?to=/:account/workers/services/view/crashes-cells-api/production/metrics|dashboard>")
    slack_post(slack_token, channel, "\n".join(lines))
    print("posted to slack")


if __name__ == "__main__":
    main()
