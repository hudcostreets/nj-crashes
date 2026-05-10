# `njsp crash-log fsck` — integrity checks against git lineage

## Motivation

`crash-log.parquet` is a growing record of crash-update events, each row indexed by `(accid, sha)` where `sha` is the 8-char prefix of the "Refresh NJSP data" git commit that introduced that update. Over time — especially with rebases, force-pushes, or cherry-picks — the `sha` column can drift from the canonical git history:

- **Orphaned SHAs**: reference commits that exist in the repo but aren't reachable from HEAD (e.g., dropped during a rebase, only reachable via a stale tag)
- **Missing SHAs**: reference commits that don't exist in the local repo at all (e.g., were force-pushed away on remote and GC'd)
- **Wrong-kind SHAs**: reference commits whose message isn't "Refresh NJSP data" (shouldn't happen in production but can after history rewrites)

These conditions can break downstream consumers:
- **Slack**: messages link to commit diffs — orphaned SHAs 404 after GC
- **www**: FE links to crash-log entries assume canonical history
- **Future pipeline runs**: crash_log computations that walk git history may silently skip orphaned SHAs

We need a `fsck`-style command that finds and reports these integrity issues, so we can fix them before pushing or breaking downstream state.

## Command

```
njsp crash-log fsck [OPTIONS]
```

### Options

- `-r, --ref <ref>` — reference to check reachability against (default: `HEAD`)
- `-p, --path <path>` — path to crash-log parquet (default: `njsp/data/crash-log.parquet`)
- `-s, --strict` — exit non-zero on any finding (useful for pre-commit / CI)
- `-q, --quiet` — only print summary counts
- `--check-messages` — also verify each SHA's commit message starts with "Refresh NJSP data"
- `--slack` — cross-validate against Slack: for each `(accid, sha)`, check that Slack's thread for `accid` contains a commit link to `sha`. Requires `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`.
- `--fix-slack` — (implies `--slack`) post edits to Slack to update stale commit links to match crash-log. Requires confirmation.

### Output

Default (human-readable):

```
Crash-log: njsp/data/crash-log.parquet (14281 rows, 1125 unique SHAs)
Reference: HEAD (1e1608549cf)

✓ All 1125 SHAs reachable from HEAD
✓ All 1125 SHAs are "Refresh NJSP data" commits
```

On failure:

```
Crash-log: njsp/data/crash-log.parquet (14281 rows, 1125 unique SHAs)
Reference: HEAD (1e1608549cf)

✗ 3 SHAs not reachable from HEAD:
  - abc12345 (2 rows, accids: [14212, 14242]) — reachable via ref 'data'
  - def67890 (1 row, accid: [14510]) — missing from repo

✗ 1 SHA has wrong message type:
  - 82f2c59a — "Add per-XML DVX provenance; include date in refresh commit messages"
    (not a "Refresh NJSP data" commit)

Hint: run `njsp crash_log compute --force` to rebuild crash-log from current history,
      or manually remap SHAs with `njsp crash-log remap-shas`.
```

With `--slack`:

```
Slack cross-validation: C05JZ0C5LEL (1883 messages)

✗ 3 accids have stale commit links in Slack:
  - 14212: Slack→304fb928, crash-log→0cd815d3
  - 14242: Slack→fddae468, crash-log→0cd815d3
  - 14507: Slack→6e84354d, crash-log→1bb9f0e2

Run `njsp crash-log fsck --fix-slack` to post edits.
```

## Implementation

Single-pass validation:

1. Load `crash-log.parquet`
2. `git rev-list <ref>` → set of 8-char prefixes (reachable)
3. `git rev-list --all` → set of 8-char prefixes (present-in-repo)
4. For each unique SHA in crash-log:
   - Check set membership → classify (reachable / orphaned / missing)
   - If `--check-messages`: `git log -1 --format=%s <sha>` → startswith("Refresh NJSP data")?
5. Group findings by category, print summary

For `--slack`: reuse existing `ChannelClient` infrastructure. For each accid in crash-log, fetch its thread, extract all commit-URL fragments, compare to crash-log's `sha` for that `accid`.

## Exit codes

- `0`: all checks pass (or warnings only without `--strict`)
- `1`: integrity issues found (with `--strict`), or CLI errors

## Future: auto-remap

A separate command `njsp crash-log remap-shas` could attempt to fix orphaned SHAs by finding a replacement via commit-content matching (e.g., "if orphan SHA `abc12345` modifies the same `FAUQStats2026.xml` as reachable SHA `def67890`, remap `abc12345` → `def67890`"). This is speculative and should be interactive or gated behind confirmation.

## Relation to existing code

A similar check was ad-hoc'd during debugging (see commit history around the 4/9-4/10 rebase work). Promoting to a CLI makes it reusable and enforceable (e.g. pre-push hook).
