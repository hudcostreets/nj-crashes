from contextlib import nullcontext
from functools import wraps
from os.path import join, exists

from click import option
from dotenv import dotenv_values
from utz import env, call
from utz.cli import flag

from .channel_client import DEFAULT_BATCH_SIZE, DEFAULT_MAX_RECS, ChannelClient
from .config import SLACK_IM_ID_VAR, SLACK_CHANNEL_ID_VAR
from ..base import njsp


@njsp.group('slack')
def slack():
    """Manage automated posts to the #crash-bot channel in HCCS Slack."""
    pass


batch_size_opt = option('-b', '--slack-batch-size', type=int, default=DEFAULT_BATCH_SIZE, help=f'Batch size for paginated fetches from the Slack API (default: {DEFAULT_BATCH_SIZE})')
channel_opt = option('-h', '--channel', help=f'Slack channel ID to post to; defaults to ${SLACK_CHANNEL_ID_VAR}')
im_opt = option('-i', '--im', is_flag=True, help=f'Use IM channel indicated by {SLACK_IM_ID_VAR}')
max_recs_opt = option('-m', '--slack-max-recs', type=int, default=DEFAULT_MAX_RECS, help=f"Fetch up to this many messages from Slack, and update cache (as opposed to just reading cached messages; default: {DEFAULT_MAX_RECS})")
dry_run_opt = flag('-n', '--dry-run', help="Avoid Slack API requests, cache updates, etc.")


def channel_client_opts(fn):
    """Decorator to add channel and IM options to a function."""
    @batch_size_opt
    @channel_opt
    @im_opt
    @max_recs_opt
    @dry_run_opt
    @wraps(fn)
    def _fn(
        slack_batch_size: int,
        channel: str | None,
        im: bool,
        slack_max_recs: int | None,
        dry_run: bool,
        *args,
        **kwargs,
    ):
        env_path = join('.slack', '.env')
        if exists(env_path):
            config = dotenv_values(env_path)
            env_ctx = env(**config)
        else:
            env_ctx = nullcontext()

        with env_ctx:
            if im:
                if channel:
                    raise ValueError("Cannot specify both --im and --channel")
                channel = env.get(SLACK_IM_ID_VAR)
            client = ChannelClient(
                channel=channel,
                dry_run=dry_run,
                batch_size=slack_batch_size,
                max_recs=slack_max_recs,
            )

        return call(
            fn,
            *args,
            **kwargs,
            slack_batch_size=slack_batch_size,
            channel=channel,
            im=im,
            slack_max_recs=slack_max_recs,
            dry_run=dry_run,
            client=client,
        )

    return _fn
