# `slack/channel_client.py` cleanup

## Motivation

We hit a NaN-on-int bug in `accid_thread` (commit `2e964e9c13d`)
where bot replies missing the `ACCID` payload broke
`.astype(int)`. The fix was a one-line `.dropna()`, but the
underlying code is fragile in ways that suggest more bugs lurk:

```python
reply_accids = (
    replies_df.metadata
    .apply(Series).event_payload
    .apply(Series).ACCID.astype(int)
)
```

That's 3 chained `.apply(Series)`s with no defensive checks. Any
reply with an unexpected metadata shape will blow up the entire
sync. Given the bug only surfaced in production after months,
we can assume there are more shapes we haven't seen yet (Slack
restored deletes? edited messages? cross-posted from another bot?
Workflow Builder posts?).

## Concerns

1. **Brittle metadata parsing**. Multi-step `apply(Series)` chains
   on free-form Slack metadata. Should use explicit field-by-field
   normalization with `.get()` defaults.
2. **All-or-nothing failure mode**. One bad reply aborts sync of
   all crashes. A single NaN in `accid_thread` → no crashes
   posted that day. Per-crash `try/except` would limit blast
   radius.
3. **No test coverage** of the parse path. Adding a couple
   recorded fixtures of weird metadata shapes would catch
   regressions.
4. **`channel_client` is doing too much** — `accid_thread`, fetch
   pagination, dedupe, re-edit detection, etc. all in one class.
   Worth splitting fetch (paginated, cache-aware) from interpret
   (turn raw msgs into typed records).

## Proposed work

### Phase 1: Defensive parsing
- Replace `.apply(Series).field.astype(int)` chains with a
  helper like `extract_accid(row) -> int | None` that returns
  None for any malformed metadata. Drop None rows, log count.
- Wrap the per-crash sync loop in `try/except` so a single bad
  thread skips that crash but lets the rest proceed.
- Emit a structured log of skipped crashes so we can audit
  what's failing.

### Phase 2: Fixtures + tests
- Capture 5-10 real reply messages of varying shapes (regular bot
  reply, deleted/restored, edited, no-metadata, alternate ACCID,
  etc.) as JSON fixtures under `tests/slack/fixtures/`.
- Unit-test `accid_thread` with each fixture; lock down expected
  behavior (skip vs. raise).

### Phase 3: Refactor (optional)
- Split `ChannelClient` into `ChannelFetcher` (pagination, cache,
  rate-limit) + `MessageParser` (raw → typed). Each is testable
  in isolation.

## Out of scope
- Replacing the Slack client lib entirely.
- Migration to Slack Block Kit / new posting format (would invalidate
  parsed-metadata assumptions).
