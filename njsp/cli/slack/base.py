from click import option
from utz import env
from utz.cli import flag

from .channel_client import CHANNEL_OPTS
from ..base import njsp


@njsp.group('slack')
def slack():
    """Manage automated posts to the #crash-bot channel in HCCS Slack."""
    pass


SLACK_CHANNEL_ID_VAR = "SLACK_CHANNEL_ID"
SLACK_CHANNEL_ID = env.get(SLACK_CHANNEL_ID_VAR)


channel_opt = option(*CHANNEL_OPTS, help=f'Slack channel ID to post to; defaults to ${SLACK_CHANNEL_ID_VAR} ({SLACK_CHANNEL_ID or "unset"})')
dry_run_opt = flag('-n', '--dry-run', help="Avoid Slack API requests, cache updates, etc.")
