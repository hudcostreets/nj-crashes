from utz import err

from njsp.cli.slack import slack
from njsp.cli.slack.base import dry_run_opt, channel_opt
from njsp.cli.slack.channel_client import ChannelClient


@slack.command('rm-dupes')
@channel_opt
@dry_run_opt
def rm_dupes(
    channel: str | None,
    dry_run: bool,
):
    """Delete duplicate threads referencing the same ACCID."""
    client = ChannelClient(channel=channel, dry_run=dry_run)
    to_rm = client.accid_dups_to_remove()
    recs = to_rm.reset_index().to_dict('records')
    err(f"Found {len(recs)} ACCID-duplicates:")
    for rec in recs:
        accid = rec['ACCID']
        ts = rec['ts']
        text = rec['text']
        if dry_run:
            err(f"Would delete {accid=}/{ts=}: {text}")
        else:
            err(f"Deleting {accid=}/{ts=}: {text}")
            client.delete_msg(ts)
