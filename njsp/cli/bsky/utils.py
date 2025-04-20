from urllib.parse import urlparse

from pandas import to_datetime

DID = 'i3ywdbdpyoyslxaxxncmmasj'
HANDLE = 'crashes.hudcostreets.org'

SCHEME = 'at'
NETLOC = f'did:plc:{DID}'
PATH_PREFIX = '/app.bsky.feed.post'

# @crashes.hudcostreets.org was populated with all crashes from 2021-2025, at this commit ca. 2025-03-22
INITIAL_BACKFILL_SHA = '76a42ac4a457a47251a7225301f38d58b6d5db82'
BACKFILL_RUNDATE = to_datetime('2025-03-23').tz_localize('US/Eastern')


def uri2tid(uri: str) -> str:
    parsed = urlparse(uri)
    if parsed.scheme != SCHEME:
        raise ValueError(f'{uri=} has unexpected scheme {parsed.scheme=} != {SCHEME}')
    if parsed.netloc != NETLOC:
        raise ValueError(f'{uri=} has unexpected netloc {parsed.netloc=} != {NETLOC}')
    prefix, tid = parsed.path.rsplit('/', 1)
    if prefix != PATH_PREFIX:
        raise ValueError(f'{uri=} has unexpected path {prefix=} != {PATH_PREFIX}')
    return tid
