# Track crash-log.parquet in DVX with GC

## Status (2026-05-10)

The DVX-track migration is **done** — `njsp/data/crash-log.parquet.dvc`
exists and is updated by daily CI ("Update crash log" stage). The
remaining open piece from this spec is **age-based retention on the
DVX cache** (`dvx gc --older-than 30d`), which requires upstream DVX
work.

## Background

`crash-log.parquet` was historically managed out-of-band on S3 as a
mutable object. Each pipeline run appended a few rows and re-uploaded.
This had downsides:
- No version history (can't roll back)
- S3 state can be corrupted without detection
- Not reproducible from git alone

## Existing DVX support

`dvx gc` already exists with:
- Workspace/branch/tag/all-commits scoping
- `--dry` mode
- `--safe` mode (won't delete locally unless backed up to remote)
- `--cloud` to also GC remote storage
- Delegates to DVC's cache GC under the hood

What's **missing** for this use case:
- **Age-based retention** (`--older-than 30d`): purge versions older than a threshold
- **Per-artifact retention policies**: different retention per artifact

## Proposal

### Track crash-log.parquet as a DVX artifact

Instead of S3 out-of-band management:
1. Make `crash_log compute` write to a local `crash-log.parquet`
2. Track it with a `.dvc` file (DVX-cached, not git-tracked — it's 500KB+ and growing)
3. `dvx push` sends it to S3 DVX cache (replaces the current direct S3 upload)
4. Each pipeline run produces a new version; DVX records the hash

Benefits:
- Full version history in DVX cache
- Rollback via `git checkout <old-sha> -- crash_log.dvc && dvx pull`
- Crash-log integrity tied to git history
- `dvx status` shows if crash-log is stale

### Use `dvx gc` to manage cache growth

After age-based retention is implemented upstream:
```bash
dvx gc --older-than 30d --cloud  # purge crash-log versions older than 30 days
```

### Migration steps (DONE)

1. ~Remove the `--s3` flag from `crash_log compute` (no more direct S3 upload)~
2. ~Have the command write to `njsp/data/crash-log.parquet` locally~
3. ~Create `njsp/data/crash-log.parquet.dvc` as a normal DVX output (not side-effect)~
4. ~Configure S3 as DVX remote (may already be set up)~
5. ~Pipeline does: `dvx run njsp/data/crash_log.dvc` → updates parquet → DVX hashes + commits `.dvc` → `dvx push`~

All complete as of `8258c18c602 Track crash-log.parquet in DVX`.
Daily pipeline now runs `crash-log.parquet.dvc` as a stage; each run
adds a `Update crash log` commit with the new md5.

### Upstream DVX work needed

- Age-based GC (`--older-than`): file an issue/spec in DVX repo
- Per-artifact retention policy config (optional, can start with global)

## XMLs stay git-tracked

XMLs should NOT move to DVX cache. They're small (~2MB each), the git history is actively used by `crash_log compute` (which walks `git log` to find which SHA introduced each crash), and other code reads XMLs at historical commits. See `dvx-external-https-deps.md` for tracking XMLs' HTTPS provenance while keeping them in git.

## Open questions

- Should crash-log.parquet be a proper DVX output (with `outs:` and hash), or remain a side-effect stage that happens to also track its output? Proper output seems cleaner.
- What's the interaction between `dvx gc` and `dvx push`/`dvx pull`? (Don't GC something that hasn't been pushed yet — the existing `--safe` flag may handle this.)
