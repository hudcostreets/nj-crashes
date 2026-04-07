# Migrate crash-bot Slack + Bluesky to `thrds`

## Context

The crash-bot has hand-rolled thread sync logic in both `njsp/cli/slack/channel_client.py` (~400 lines) and `njsp/cli/bsky/client.py` (~250 lines). The `thrds` library now provides the same sync algorithm generically for Slack, Discord, and Bluesky. Migrating reduces ~650 lines of sync logic to thin wrappers around `thrds.sync()`.

## Current architecture

### Slack (`njsp/cli/slack/`)
- **`channel_client.py`**: `ChannelClient` wraps `slack_sdk.WebClient`
  - `sync_crash()`: hand-rolled diff loop (edit if changed, post if new, delete extras)
  - `accid_thread()`: lookup existing thread by message metadata (`event_type`, `ACCID`)
  - `post_msg()` / `update_msg()` / `delete_msg()`: thin API wrappers with metadata
- **`msg.py`**: `Msg` and `Thread` dataclasses for Slack messages
- **`sync.py`**: CLI entry point (`njsp slack sync`)
- **`config.py`**: env var names for token/channel

### Bluesky (`njsp/cli/bsky/`)
- **`client.py`**: `Client` wraps `atproto.Client`
  - `sync_crash()`: similar diff loop, but handles no-edit by delete+repost
  - Post cache in `.bsky/cache/` JSON files
  - Retry logic for newly-created posts
- **`thread.py`**: `Thread` dataclass with `ReplyRef` validation
- **`post.py`**: `BskyPost` wrapper around `PostView`
- **`sync.py`**: CLI entry point (`njsp bsky sync`)

### What both share
The same pattern: given a crash log, build a list of desired message strings, then sync that list against the existing thread. The diff/sync logic is duplicated.

## Migration plan

### 1. Add `thrds` dependency

```
pip install thrds[slack,bsky]
# or in pyproject.toml:
dependencies = ["thrds[slack,bsky]"]
```

Note: thrds' Slack client uses urllib (zero deps). The crash-bot currently uses `slack_sdk` for thread lookup by metadata (search API). We need to keep `slack_sdk` for the metadata lookup, but can use `thrds.SlackClient` for the actual sync.

Actually, `thrds.SlackClient` also uses urllib, so we can either:
- **Option A**: Use `thrds.SlackClient` directly (simpler, drop `slack_sdk`)
- **Option B**: Subclass `thrds.SlackClient` to add metadata support
- **Option C**: Keep `slack_sdk` for lookup only, use `thrds.sync()` with a thin adapter

Recommend **Option A** — `thrds.SlackClient` already has `post`/`edit`/`delete`/`list_messages`. The only thing missing is metadata on post/edit calls. Either add optional metadata support to `thrds.SlackClient`, or handle metadata as a post-sync step.

### 2. Refactor `sync_crash()` → build desired + `thrds.sync()`

The crash-specific logic stays:
```python
def build_thread_messages(crash_log: Log) -> list[str]:
    """Build desired message list from crash log."""
    vs = [(i, v) for i, v in enumerate(crash_log.versions) if not v.is_noop]
    messages = [vs[-1][1].slack_update_str(vs[-1][0], len(vs))]
    if len(vs) > 1:
        messages.append("Previous versions:")
        messages.extend(v.slack_update_str(i, len(vs)) for i, v in vs[:-1])
    return messages
```

The sync becomes:
```python
from thrds import Thread, SlackClient

client = SlackClient(token=token, channel=channel)
desired = Thread(messages=build_thread_messages(crash_log))
result = client.sync(desired, thread_id=existing_thread_ts)
```

### 3. Bluesky migration

Same pattern:
```python
from thrds import Thread, BskyClient

client = BskyClient(handle=handle, password=password)
desired = Thread(messages=build_thread_messages_bsky(crash_log))
result = client.sync(desired, thread_id=existing_root_uri)
```

The bsky-specific message formatting (`facets` for rich text links) stays in crashes. `thrds` just syncs plain text; if bsky needs facets, the `BskyClient` would need to accept structured content (not just strings). Options:
- Plain text only (lose link formatting) — probably fine for crash updates
- Extend `thrds.Thread` to accept `list[str | RichMessage]` where platforms can attach metadata — future work

### 4. Thread lookup

The crash-bot needs to find existing threads by ACCID. This is crash-specific, not library concern:

**Slack**: Currently uses message metadata search (`conversations.history` + filter by metadata). This stays in crashes — `thrds` doesn't know about ACCIDs.

**Bluesky**: Currently uses post cache (JSON files). This stays too.

The lookup returns a `thread_id` (Slack `thread_ts` or Bsky root URI), which is passed to `thrds.sync()`.

### 5. What gets deleted

| File | Action |
|------|--------|
| `njsp/cli/slack/channel_client.py` | Replace `sync_crash()` body (~80 lines) with `thrds.sync()` call. Keep `accid_thread()` lookup, metadata posting. |
| `njsp/cli/slack/msg.py` | Keep (crash-specific message formatting) |
| `njsp/cli/slack/sync.py` | Keep (CLI entry point, minimal changes) |
| `njsp/cli/bsky/client.py` | Replace `sync_crash()` body with `thrds.sync()` call. Keep auth, cache, retry. |
| `njsp/cli/bsky/thread.py` | Remove (replaced by `thrds.Thread`) |
| `njsp/cli/bsky/post.py` | Keep (crash-specific `BskyPost` wrapper) |

Net reduction: ~150-200 lines of sync logic replaced by `thrds.sync()` calls.

### 6. Metadata support in thrds (future)

Slack messages can carry metadata (`event_type`, `event_payload`). Discord has embeds. Bluesky has facets. Currently `thrds.Thread` is `list[str]`. A future extension could be:

```python
@dataclass
class RichMessage:
    content: str
    metadata: dict | None = None  # Platform-specific

Thread(messages=[
    RichMessage("crash text", metadata={"event_type": "new_crash", "event_payload": {"ACCID": "12345"}}),
    "Previous versions:",  # Plain string still works
])
```

This is out of scope for the initial migration — the crash-bot can add metadata in a post-sync step (edit the message to add metadata after `thrds` creates it).

## Open questions

- Should `thrds.SlackClient` support message metadata natively? Or is that a crashes-specific concern?
- Bluesky rich text (facets): plain text OK for crash updates? Or do we need link formatting?
- Should `thrds` be published to PyPI, or installed via git dep?
