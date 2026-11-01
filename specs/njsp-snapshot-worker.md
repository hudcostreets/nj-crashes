# NJSP snapshot Worker

**Status**: implemented on branch `njsp-snapshot-cfw` (not deployed). Deploy steps: [Deploy](#deploy).

**Motivation.** NJSP's fatal-crash XML (`FAUQStats{year}.xml`) is a mutable "as of" feed: each day's version is a snapshot of what NJSP had reported by then, and the project's reporting-delay work depends on having one per day. Today the only capture is the GHA daily (`.github/workflows/daily.yml`, cron `30 15 * * *`), whose first DVX stage (`njsp/data/refresh.dvc` → `njsp refresh_data --s3`) commits + pushes changed XMLs. Most daily failures happen after that stage, so the snapshot usually survives; but anything that breaks *before* it loses the day:

- 2026-10-29: `ubuntu-latest` moved to 26.04 (system Python 3.14), `uv sync` failed building `pyogrio` → no refresh → the 10/29 "as of" state is unrecoverable (Wayback has nothing).
- GHA schedules routinely fire hours late, so warnings arrive too late to intervene the same day.

**Goal.** Decouple the snapshot from GHA: a Cloudflare Worker on a CF cron captures the XML into Git itself, then dispatches the daily. Git stays the SoT for XML history: no backfill, and every consumer that walks the XMLs' Git history (`njsp/data/crash-log.parquet.dvc` etc.) keeps working unchanged.

## Design (as implemented)

### Worker: [`njsp-snapshot/`]
TS, pnpm, wrangler-deployed into the HCCS CF account (per `infra/__main__.py`'s convention: Pulumi owns the KV namespace, wrangler owns the script). Cron `7 * * * *` (hourly). `wrangler.toml` `[vars]` carry the repo/branch/workflow, commit identity, Slack channel and `DRY_RUN`; dev port `51947`.

- `src/snapshot.ts` — `runTick`: the capture + alert logic, dependency-injected (GitHub `Repo`, upstream `fetch`, KV, alerter, clock) so it's unit-testable.
- `src/dvc.ts` — `.xml.dvc` parse + `renderXmlDvc`, the TS port of `render_xml_dvc` (below).
- `src/github.ts` — REST client: ref/commit read, Contents (raw) read, Git Data API commit, Actions runs + `workflow_dispatch`.
- `src/rundate.ts` — RUNDATE parsing, `rundate_short`, commit message, ET date helpers.
- `src/index.ts` — `scheduled` handler + read-only `GET /` returning the persisted tick state as JSON (no secrets in it).

Each tick:

1. **Years**: `[Y-2, Y-1, Y]` with `Y` = the ET year — the same set `refresh_data` defaults to (not "prior year only in January": NJSP re-publishes all three files every day, and the daily refreshes all three). For each year, read `data/FAUQStats{year}.xml.dvc` at `main`'s head (one `head()` snapshot per attempt, so all reads are consistent), and HEAD the NJSP URL with `refresh_data`'s exact request headers (incl. its `UA` constant — the `.dvc`'s `user_agent` field is a stale Chrome/120 string left by `dvx import-url`, which `refresh_data` doesn't use either).
2. **Per-year status** (`YearResult.status`):
   - `absent`: current-year file 404s upstream (early January) — skipped, as `refresh_data` does.
   - `unchanged`: HEAD's ETag equals `deps[0].checksum`, or its Last-Modified equals `deps[0].mtime` as an instant — `refresh_data.update_years`'s skip rule verbatim.
   - otherwise GET (rejecting non-200 and non-`text/xml` responses, like `refresh_data`; a WAF challenge page fails the tick), md5 it, and:
     - `meta`: same md5 as `main` — NJSP re-published identical bytes with a new ETag/LM. This happens to the *prior-year* files every day, and to all files on NJSP-skip days (see below). The observed headers + md5 are remembered in KV (`state.observed`), so later ticks HEAD-match them without re-GETting.
     - `content`: new bytes.
   - New year: if `FAUQStats{Y}.xml.dvc` doesn't exist on `main` yet (it's been hand-added each year, after the daily's first bare-XML commit), the Worker seeds it from `Y-1`'s `.dvc` (path names substituted) — so new-year snapshots are captured with provenance from day one.
3. **Commit only if some year is `content`**. Files: XML + `.dvc` for `content` years, `.dvc` for `meta` years (exactly the set `refresh_data` `git add`s in the same situation). Metadata-only ticks commit nothing: the daily (backstop cron) still commits those `.dvc` bumps as `Run refresh`, as today.
4. **Don't race the daily**: if any of `daily.yml`'s 20 most recent runs on `main` is `queued`/`in_progress`/`waiting`/`pending`/`requested`, the tick ends `daily-running` and the next tick retries.
5. **One commit** via the Git Data API (blobs → tree on `base_tree` → commit → `PATCH` ref with `force: false`). A 422 (non-fast-forward) restarts the whole tick from the new head (≤3 attempts).
   - Message: `Refresh NJSP data (M/D)` from the current-year XML's RUNDATE (`refresh_data` + `rundate_short`; read from `main` when the current year itself is `unchanged`); bare `Refresh NJSP data` when there's no current-year RUNDATE (January 404). `njsp update_pqts` (`git log --grep=^Refresh NJSP data`) and `slack_post.sh` both key on that prefix.
   - Author = committer = `GitHub Actions <ryan-williams@users.noreply.github.com>` (the daily's `Configure Git author` identity).
6. **Dispatch** `daily.yml` on `main` (`workflow_dispatch`), recording `{at, sha}` in KV. The daily's `refresh.dvc` then HEAD-matches every year → no download, no commit (verified by the "next tick is HEAD-only" test, which applies the same rule).
7. **Alerts** (Slack `chat.postMessage` to `SLACK_CI_CHANNEL_ID` = `C0BCYGVL9FD`, the channel `notify-ci-failure.sh` posts daily failures to), each deduped by a key kept in `state.alerts`:
   - `errors:{ET date}` — `errorThreshold` (3) consecutive failed ticks (GitHub/NJSP/WAF errors, non-FF exhaustion, …). With the hourly cron, a capture failing from NJSP's ~10:00 ET publish alerts by ~12:07 ET. This is the "not captured by ~13:00 ET" signal: a successful tick always leaves `main` in sync with upstream.
   - `stale:{ET date}` — from 13:00 ET, after a successful tick (not `daily-running`), the current-year (prior-year while current 404s) RUNDATE is older than *yesterday*: NJSP hasn't published for ≥2 days. Single skipped days are routine and not alerted (history below).
   - `daily:{sha}` — a dispatched daily hasn't concluded `success` within 120 min (no run found, still running, or failed — the daily's own failure notify covers the last case too; this one also catches hung / never-started runs).
8. `DRY_RUN=1` does everything except GitHub writes (commit, dispatch) and Slack posts (alerts are logged instead). KV state is still written. Unset `GH_TOKEN` → anonymous GitHub reads (public repo), for local dev.

### `.xml.dvc` rendering: byte-identical to `refresh_data`
`njsp/cli/refresh_data.py`'s `update_xml_dvc` is now a thin I/O wrapper over a pure `render_xml_dvc(dvc_text, content, headers, fetched)` (PyYAML load → set `outs[0].{md5,size}`, `deps[0].{size,checksum,mtime}`, `meta.import.fetched` → `dump(sort_keys=False)`). The TS port edits the existing text line-wise (replace a key's line, dropping folded continuations; or append new keys at the end of their mapping in PyYAML's insertion order: `size`, `checksum`, `mtime`; `meta.import` appended if absent), with a scalar emitter matching PyYAML's quoting (YAML 1.1 implicit resolvers + plain-scalar indicator rules: e.g. `'"etag"'`, `W/"etag"` plain, `'12345'`, `'2026-10-31'`).

This is exact as long as the input `.dvc` is already in PyYAML-canonical form — guarded by `test_committed_xml_dvcs_are_pyyaml_canonical` (all 19 committed `FAUQStats*.xml.dvc`s round-trip). Golden test: `njsp/tests/test_refresh_data.py::test_snapshot_worker_goldens` renders 10 cases (current shape, bare pre-2026 shape, weak/unquoted/numeric ETags, ETag-only, LM-only, no headers, no response) with Python into `njsp-snapshot/test/fixtures/dvc-golden.json` (`UPDATE_GOLDEN=1` to regenerate) and asserts the committed file matches; `njsp-snapshot/test/dvc.test.ts` asserts the TS renderer reproduces every `expected` byte-for-byte.

`meta.import.fetched`: the Worker writes the **ET** date. Python writes `datetime.now().date()` in the runner's local TZ (UTC on GHA). They only differ for fetches between 00:00 UTC and midnight ET, and nothing compares the two (the daily never rewrites a `.dvc` the Worker just wrote — HEAD matches).

### Daily-side changes
- **Fetch log** (`S3_XML_FETCH_LOG`): the HEAD-match skip path *does* log a record (`changed=False`, `rundate` from the local XML), so Worker captures wouldn't vanish, but they'd be indistinguishable from no-op polls. Now each record also carries `md5` and `logged_from` (`'fetch'`), and on the skip path, if the committed `deps[0].mtime` differs from the year's last logged `last_modified`, `refresh_data` first appends an `unlogged_capture_record` (`logged_from='git'`, `fetch_time=None` — the Worker commit's date has it; `changed` = md5 vs last logged md5, `None` while the last row predates the `md5` column). Tested in `test_refresh_data.py`. The log has no readers in-repo yet.
- **Unpushed-commit check** (`daily.yml`, new step "Check all commits were pushed"): dvx's `--push each` path (`dvx/run/executor.py`) runs `git push` after each stage commit and on rejection only logs `⚠ push failed` — no pull/rebase, no failure. So a Worker commit landing between the daily's checkout and its first push would leave *every* subsequent stage commit unpushed under a green run. The Worker skips while a daily is queued/running, but a run created between its Actions check and its ref update (seconds) can still race. The new step fails the run (→ Slack notify) if `HEAD` has commits not on `origin/<branch>`. A dvx-side `pull --rebase` before push would recover automatically; not done here (cross-project).
- GHA `schedule:` cron kept as a backstop (HEAD-match → nop for the XMLs; still commits metadata-only `.dvc` bumps). `concurrency: group: daily` already serializes the Worker's dispatched run with the scheduled one; unchanged.

### Multi-snapshot days: no change needed
Hourly polling can capture >1 NJSP update per day (historically NJSP re-runs late, e.g. RUNDATE `10:52`, `11:15`). Every git-history consumer keys on RUNDATE timestamps or commit SHAs, not commit dates:
- `njsp/crash_log.py` walks every commit touching the XMLs; events are `(accid, sha)` with the commit's XML `rundate` (full timestamp). `feed_snapshot` picks the oldest rundate ≥ `as_of` — more snapshots = finer resolution.
- `njsp/data/crash-log.parquet.dvc` is gated by `git_log_deps` on the tip commit touching `/data/FAUQStats*.xml` — any number of commits works.
- `slack_post.sh` passes all `Refresh NJSP data` commits from the last 7 days to the idempotent `njsp slack sync`.
- `update_pqts` records the latest `Refresh NJSP data` sha in `rundate.json`.

So the Worker commits every content change it sees.

### Rollbacks: side branch, not `main`
2026-11-01 06:00:50 UTC (right at the DST fallback), NJSP re-published older XMLs: 2026's RUNDATE went `Sat Oct 31` → `Wed Oct 28` (429 → 421 crashes), 2025's `Sat Oct 31` → `Tue Oct 27`. The staging Worker faithfully committed it (`9ab94c1d7c7`); in prod that would have hit `main` and dispatched the daily.

Now a fetched version whose RUNDATE is older than the branch's (`isRollback`, comparing instants; EDT/EST-aware) is a `rollback`:
- Worker: committed to `GH_ROLLBACK_BRANCH` (`njsp-rollbacks`; staging: `njsp-snapshot-staging-rollbacks`), created from `main`'s head on first use; one Slack alert per version; `main` untouched, no dispatch. `state.rollbacks[year]` (`md5` + `main`'s md5) stops hourly re-GETs / re-commits while NJSP keeps serving it. The side branch keeps every rolled-back version, so NJSP's versions can be interleaved after the fact.
- `refresh_data` (`is_rollback`): skips the year (no write / `git add`), still logs the fetch to the R2 fetch log.

### NJSP skip-day history (for the `stale` rule)
From `git log` on `data/FAUQStats*.xml` since 2025-01-01 (current-year XML's RUNDATE per commit): 647 distinct RUNDATE days of 669; 99% of RUNDATEs are `10:00` ET (rest 10:15–11:15). Of the 22 missing days, some are capture failures (e.g. 10/29), and the rest NJSP skips — visible as `Run refresh` commits (new ETag/LM, identical bytes: 7/1, 9/19, 9/20, 10/27) or HEAD-match no-ops (6/24). Runs of missing days: 11×1, 3×2, 1×5 (2025-12-31…2026-01-04, the new-year 404 window). Alerting only on ≥2-day staleness → 3 alerts in those 22 months (plus New Year, which is real staleness of the new feed). Single-day skips (~1/month) aren't alerted; a failing Worker is caught by `errors`.

## Known risks / follow-ups
- **NJSP's WAF (Imperva) vs CF egress: verified OK (2026-10-31).** A probe Worker run on CF's edge (`wrangler dev --remote`, colo IAD) got `200 text/xml` for HEAD + GET, and the GET's bytes hashed to `main`'s committed md5 (`aedd1637…`, 193397 B). One wrinkle it surfaced: through CF's network the GET's body arrives compressed, so its ETag comes back weak (`W/"2f375-…"`) while HEAD's is strong; the Worker normalizes to the strong form (`strongEtag`), else its `.dvc`s would diverge from `refresh_data`'s.
- The Worker can't detect its own cron not running. Possible follow-up: a daily step that reads `GET /` and warns if `lastTick.at` is >2h old.
- Commits via the API are unsigned/"Unverified" (same as the daily's).

## Deploy
Two Workers from one codebase (`wrangler.toml` top level + `[env.staging]`):
- **`njsp-snapshot-staging`**: commits to branch `njsp-snapshot-staging` (forked from `main`), `DISPATCH=0` (the daily on that branch would build + deploy prod), own KV namespace, alerts prefixed `[staging] `. Run it alongside the GHA daily for a few days, then check each of its captures against `main`'s: same XML bytes, and `.dvc` identical except `meta.import.fetched` (ET date vs runner's UTC date).
- **`njsp-snapshot`** (prod): commits to `main` and dispatches the daily.

Run from the **main checkout** after merging (`infra/hccs-run` / `infra/pul` read the repo-root `.envrc`; `put-secrets` reads `NJSP_SNAPSHOT_GH_TOKEN` + `SLACK_BOT_TOKEN` from the direnv-loaded env and pipes them to `wrangler secret put` on stdin):

```bash
# 1. KV namespaces (Pulumi); paste the ids into njsp-snapshot/wrangler.toml (top-level + `env.staging`) and commit
infra/pul preview
infra/pul up
infra/pul stack output kv_namespace_ids

# 2. Install, test
pnpm --dir njsp-snapshot install
pnpm --dir njsp-snapshot test

# 3. Staging: branch, secrets, deploy
git push h main:refs/heads/njsp-snapshot-staging
infra/hccs-run njsp-snapshot/scripts/put-secrets -e staging
infra/hccs-run pnpm --dir njsp-snapshot exec wrangler deploy --env staging
curl https://njsp-snapshot-staging.<workers-subdomain>.workers.dev/

# 4. After staging's captures match `main`'s: prod
infra/hccs-run njsp-snapshot/scripts/put-secrets
infra/hccs-run pnpm --dir njsp-snapshot exec wrangler deploy
```

Local dry run (no secrets; anonymous GitHub reads; local KV):
```bash
cd njsp-snapshot && pnpm exec wrangler dev --test-scheduled --var DRY_RUN:1
curl 'http://localhost:51947/__scheduled?cron=7+*+*+*+*' && curl http://localhost:51947/
```

### Secrets
- `GH_TOKEN`: fine-grained PAT `nj-crashes-njsp-snapshot-cfw` (hudcostreets/nj-crashes only; Contents RW, Actions RW; expires 2027-11-01). Locally in `.envrc` as `NJSP_SNAPSHOT_GH_TOKEN`.
- `SLACK_BOT_TOKEN`: from `.envrc` (same bot as the daily's `secrets.SLACK_BOT_TOKEN`).

[`njsp-snapshot/`]: ../njsp-snapshot
