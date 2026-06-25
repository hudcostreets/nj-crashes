"""Lightweight CI notifications: GHA annotations + optional Slack channel."""
from os import environ
from sys import stderr

SLACK_CI_CHANNEL_ID_VAR = 'SLACK_CI_CHANNEL_ID'
SLACK_BOT_TOKEN_VAR = 'SLACK_BOT_TOKEN'


def gha_run_link() -> str | None:
    """Return the URL of the current GHA run, or None if not running in Actions."""
    server = environ.get('GITHUB_SERVER_URL')
    repo = environ.get('GITHUB_REPOSITORY')
    run_id = environ.get('GITHUB_RUN_ID')
    if not (server and repo and run_id):
        return None
    return f"{server}/{repo}/actions/runs/{run_id}"


def gha_warning(message: str) -> None:
    """Emit a GitHub Actions warning annotation. Newlines must be escaped per GHA spec."""
    escaped = message.replace('\n', '%0A').replace('\r', '%0D')
    print(f"::warning::{escaped}")


def slack_ci_post(message: str) -> bool:
    """Post `message` to the channel in `$SLACK_CI_CHANNEL_ID`. No-op if unset.

    Returns True on success, False if skipped or failed (failures only logged, never raised).
    """
    channel = environ.get(SLACK_CI_CHANNEL_ID_VAR)
    token = environ.get(SLACK_BOT_TOKEN_VAR)
    if not channel or not token:
        return False
    try:
        from slack_sdk import WebClient
        WebClient(token=token).chat_postMessage(channel=channel, text=message, unfurl_links=False, unfurl_media=False)
        return True
    except Exception as e:
        print(f"slack_ci_post failed: {type(e).__name__}: {e}", file=stderr)
        return False


def notify_ci(message: str) -> None:
    """Emit a GHA `::warning::` annotation AND post to the CI Slack channel.

    The Slack post auto-appends a link to the current GHA run when available.
    Both sinks are best-effort; the call never raises.
    """
    gha_warning(message)
    link = gha_run_link()
    slack_message = f"{message}\n<{link}|GHA run>" if link else message
    slack_ci_post(slack_message)
