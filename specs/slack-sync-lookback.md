# `njsp slack sync`: smart lookback instead of arbitrary 7d window

## Status quo

`njsp/data/slack_post.sh` calls:

```bash
refresh_shas=$(git log --format=%H --grep="Refresh NJSP data" --since="7 days ago")
njsp slack sync -l njsp/data/crash-log.parquet $refresh_shas_as_r_flags
```

The 7-day window is arbitrary. Motivations for having *some* lookback: if a daily run fails for a day or two, the next successful run should catch up on missed posts. But 7d is both too short (what if we're down longer?) and too long (it walks refresh commits that are almost certainly already fully synced).

## Proposal

Replace "last 7 days of refresh commits" with "walk back from HEAD until you find a refresh commit that's fully synced to Slack".

### Algorithm

1. Walk `git log --grep="^Refresh NJSP data"` from HEAD, newest first.
2. For each refresh commit `C`:
   a. Find all crash-log rows with `sha == C[:8]`.
   b. For each such `(accid, sha)` row, compare crash-log's version text (the `slack_update_str` output) against the current Slack message (top-level) for that accid.
   c. If all rows match → `C` is fully synced. Stop walking.
   d. If any row doesn't match → `C` still has work to do. Record it, continue walking.
3. Pass all recorded commits (newest → oldest) as `-r` flags to `njsp slack sync`.

### Safety cap

Cap the walk at e.g. 30 commits (≈30 days) to avoid pathological cases where Slack is completely empty (would walk all history). On hitting the cap:
- Default: error with "walked 30 commits without finding a fully-synced one; use `--force-lookback N` to go further"
- Or `--all`: sync everything from the cap back through HEAD

### CLI

The logic lives in `njsp slack sync` itself, not `slack_post.sh`. Add a flag:

```
njsp slack sync [OPTIONS]
  --auto-lookback            Walk back from HEAD until fully synced (default in CI)
  --force-lookback <N>       Walk back at most N refresh commits (default: 30)
  --since <duration>         Old behavior: all refresh commits since duration (e.g. "7d", "24h")
```

Simplify `slack_post.sh` to just:

```bash
njsp slack sync -l njsp/data/crash-log.parquet --auto-lookback
```

### Comparison: what counts as "synced"?

For each `(accid, sha)` row, the desired Slack state is defined by `slack_update_str` (via `Log.versions`). A commit is "fully synced" if, for every accid it introduced/updated:

- The accid's top-level Slack message text equals the desired `slack_update_str` for the latest version
- The accid's thread replies (if any) are the expected previous-version messages

This is the same comparison `thrds.sync()` does internally — we'd just do it read-only (dry-run) as a reachability check.

### Efficient implementation

Fetching Slack messages for every accid is expensive. Batch it:

1. Pre-fetch all bot messages from the channel (channel-wide, one pass) — this is what `ChannelClient.accid_msgs` already does.
2. Build `accid → current top-level text` lookup.
3. For each candidate refresh commit, compare crash-log's desired state against the cached lookup. No per-accid API calls needed for the walk-back check.
4. Only call `conversations.replies` for threads that need work — narrowing what we fetch.

## Benefits

- **Correctness**: never misses a missed day, however long the gap
- **Efficiency**: typical run only looks at 1 commit (today's refresh); stops immediately
- **Clarity**: "sync until caught up" matches user intent, no magic numbers
- **Debuggability**: output lists exactly which commits have outstanding work

## Downsides

- More code paths than the current `--since 7d` approach
- Requires one full channel fetch before knowing which commits to sync (current approach defers this)
- If Slack channel is manually edited (bot messages modified by humans), the walk-back might loop or over-sync — mitigated by the `--force-lookback` cap

## Related

- `specs/crash-log-fsck.md` — fsck's `--slack` cross-validation uses the same comparison primitives; the two features should share code.
- Open issue: the current `slack_post.sh` used default `-l` pointing at S3 (stale after crash-log moved to DVX), which is why the 4/10 run missed 13 accids. Fixed by passing `-l njsp/data/crash-log.parquet` explicitly. The auto-lookback feature would have caught this sooner (it would have walked back and found nothing fully synced, surfacing the staleness).
