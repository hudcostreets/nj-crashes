# NJSP snapshot Worker

**Motivation.** NJSP's fatal-crash XML (`FAUQStats{year}.xml`) is a mutable "as of" feed: each day's version is a snapshot of what NJSP had reported by then, and the project's reporting-delay work depends on having one per day. Today the only capture is the GHA daily (`.github/workflows/daily.yml`, cron `30 15 * * *`), whose first DVX stage (`njsp/data/refresh.dvc` → `njsp refresh_data --s3`) commits + pushes changed XMLs. Most daily failures happen after that stage, so the snapshot usually survives; but anything that breaks *before* it loses the day:

- 2026-10-29: `ubuntu-latest` moved to 26.04 (system Python 3.14), `uv sync` failed building `pyogrio` → no refresh → the 10/29 "as of" state is unrecoverable (Wayback has nothing).
- GHA schedules routinely fire hours late, so warnings arrive too late to intervene the same day.

**Goal.** Decouple the snapshot from GHA: a Cloudflare Worker on a CF cron captures the XML into Git itself, then dispatches the daily. Git stays the SoT for XML history: no backfill, and every consumer that walks the XMLs' Git history (`njsp/data/crash-log.parquet.dvc` etc.) keeps working unchanged.

## Design

### Worker (`njsp-snapshot/`, wrangler-deployed, CF account HCCS)
Per `infra/__main__.py`'s convention, Worker scripts are wrangler-deployed (`wrangler.toml` with `[triggers] crons`); secrets via `wrangler secret put` (run through `infra/hccs-run`).

On each cron tick (hourly, e.g. `7 * * * *`; NJSP's `<RUNDATE>` is typically ~10:00 ET):

1. For the current year (and the prior year during January, mirroring `refresh_data`'s year selection, verify), read `data/FAUQStats{year}.xml.dvc` from `main` via the GitHub Contents API, and HEAD the NJSP URL. Skip if ETag or Last-Modified matches the `.dvc`'s `deps[0]` (same rule as `njsp/cli/refresh_data.py:update_years`).
2. On change: GET the XML (same `User-Agent` as recorded in the `.dvc`), compute md5 + size, and build the updated `.xml.dvc` **byte-identical to what `refresh_data`/`update_xml_dvc` would write** (YAML key order, quoting of the ETag, `mtime` ISO format from Last-Modified, `meta.import.fetched` date in ET). The daily's subsequent `refresh.dvc` must then be a nop for the XML (HEAD matches) — verify by running the Python writer against the same inputs in a test and diffing.
3. Commit XML + `.xml.dvc` to `main` in **one** commit via the Git Data API (blobs → tree → commit → update ref, fast-forward only; on non-FF retry from the new head). Commit message must match `refresh_data`'s format (currently `Refresh NJSP data (M/D)` from RUNDATE — confirm in code), with author/committer matching what the daily's commits use, so history walkers see no difference.
4. If a `daily` run is in progress (Actions API), don't race it: skip the commit this tick (next tick retries). Otherwise, after committing, `workflow_dispatch` `daily.yml` on `main`.
5. Dead-man alert: post to Slack (`SLACK_BOT_TOKEN`, `SLACK_CI_CHANNEL_ID`; same channel the daily's failure alerts use, check) if (a) no new RUNDATE has been captured by ~13:00 ET on a weekday-or-any-day (check how often NJSP skips days historically, via `git log` on the XMLs, and pick a rule that won't cry wolf), or (b) a dispatched daily hasn't concluded `success` within ~2h. Dedupe alerts (one per condition per day) using a small KV namespace or Worker state.

Also expose a `fetch` handler (auth'd or read-only) returning last-check status as JSON for debugging; and support a `DRY_RUN` var that does everything except write to GitHub / Slack.

### Secrets
- `GH_TOKEN`: fine-grained PAT `nj-crashes-njsp-snapshot-cfw` (hudcostreets/nj-crashes only; Contents RW, Actions RW; expires 2027-11-01). Locally in `.envrc` as `NJSP_SNAPSHOT_GH_TOKEN`; put via `wrangler secret put GH_TOKEN` from a script wrapper reading the env var (never echo it).
- `SLACK_BOT_TOKEN`: from `.envrc`, same wrapper.

### Daily-side adjustments
- `refresh_data --s3` also appends to `S3_XML_FETCH_LOG` (parquet on R2). Check what happens on the HEAD-match skip path: if fetch records are only logged on download, the Worker-captured fetches would vanish from the log. Fix on the Python side (e.g. the daily logs a record for "captured by Worker" when the committed `.dvc`'s `fetched` is newer than the log's last entry), rather than writing parquet from the Worker.
- Keep the GHA `schedule:` cron as a backstop (it's idempotent: HEAD-match → nop).
- `concurrency: group: daily` already serializes runs; nothing to change, but confirm the daily's `--push each` handles a Worker commit landing between its checkout and its first push (it should pull/rebase or fail loudly; check dvx's push path).

### Multi-snapshot days
Hourly polling can capture >1 NJSP update per day, where today's daily sees only the last. Check whether `crash-log` / reporting-delay code assumes ≤1 XML commit per day (e.g. keys by commit date). If it does, either make it tolerate multiple (preferred: more resolution is good) or have the Worker only commit the first change per ET day and leave later same-day changes to the daily. Document the outcome here.

## Deliverables
- `njsp-snapshot/` Worker (TS, `pnpm`, `wrangler.toml` with distinct dev port, vitest tests covering: skip on ETag/LM match, `.dvc` rendering byte-identical to a Python-generated golden, commit-message format, in-progress-daily skip, alert dedupe).
- Python-side fetch-log tweak (+ test) if needed.
- README section / this spec updated with deploy + secret commands.
- **No deploy, no secret writes, no commits to `main`** from the implementing agent: stop at a reviewed branch; deploy is a separate, user-approved step.
