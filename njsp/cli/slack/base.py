from ..base import njsp


@njsp.group('slack')
def slack():
    """Manage automated posts to the #crash-bot channel in HCCS Slack."""
    pass
