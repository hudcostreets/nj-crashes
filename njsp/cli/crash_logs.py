import click

from njsp.cli.base import njsp
from njsp.crash_log import get_crashes, DEFAULT_ROOT_SHA


@njsp.command("crash_logs")
@click.option('-h', '--head', help='Ref to begin ancestor-traversal from')
@click.option("-r", "--root", default=DEFAULT_ROOT_SHA, help="Ref to end at")
@click.option("-s", "--since", help="Date to start from")
def crash_logs(head, root, since):
    crash_logs = get_crashes(head=head, root=root, since=since)
    print(crash_logs)
