from njsp.cli.base import njsp
from njsp.crash_log import get_crash_logs


@njsp.command("crash_logs")
def crash_logs():
    crash_logs = get_crash_logs(since='2024-01-01')
    print(crash_logs)
