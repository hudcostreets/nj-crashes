from click import argument
from utz import err, solo
from utz.cli import flag, arg

from njsp.cli.slack import slack
from njsp.cli.slack.base import channel_client_opts
from njsp.cli.slack.channel_client import ChannelClient


@slack.command('rm-dupes')
@channel_client_opts
def rm_dupes(
    client: ChannelClient,
    dry_run: bool,
):
    """Delete duplicate threads referencing the same ACCID."""
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


@slack.command('list')
@channel_client_opts
@argument('accids', type=int, nargs=-1)
def list(
    client: ChannelClient,
    accids: tuple[int, ...],
):
    """Print messages associated with the provided ACCIDs."""
    for accid in accids:
        thread = client.accid_thread(accid)
        if not thread:
            err(f"Thread not found for {accid=}")
            continue
        msgs = thread.msgs
        for msg in msgs:
            print(msg)


@slack.command('delete')
@channel_client_opts
@flag('-q', '--quiet', help="Don't print messages before deleting them")
@arg('msg-ids', nargs=-1)
def delete(
    client: ChannelClient,
    dry_run: bool,
    quiet: bool,
    msg_ids: tuple[str, ...],
):
    """Delete messages by ID."""
    for ts in msg_ids:
        if not quiet:
            res = client.client.conversations_replies(
                channel=client.channel,
                ts=ts,
                include_all_metadata=True,
                limit=1,
            )
            msg = solo(res.data['messages'])
            print(msg)
        if dry_run:
            err(f"Would delete {ts=}")
        else:
            err(f"Deleting {ts=}")
            client.delete_msg(ts)
