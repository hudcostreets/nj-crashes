from ..base import njsp


@njsp.group('slack')
def slack():
    """Post crashes to the #crash-bot channel in HCCS Slack."""
    pass
