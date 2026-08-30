# Batch reproc: rebuild every DVX target from scratch on Fargate Spot

Companion to `~/c/dvx/specs/batch-executor.md` (the reusable `dvx batch` tooling, requested 2026-08-26). This spec is the nj-crashes side: what a full-DAG reproc of this repo looks like on AWS Batch, following the pattern ctbk + pyrmts validated in July (`pyrmts/specs/done/engine-batch-packaging.md`).

## Motivation

- **r13y**: prove the whole pipeline regenerates from raw inputs. Today the only full-reproc venue is a laptop; CI runs incremental slices, and the one full-rebuild-shaped incident this week (the `--grid` cmd rot in `data/cells/*.dvc`) went undetected for a month because nothing ever re-executed those cmds.
- **Wall-time**: the DAG's wide middle (~25 years × ~5 tables of per-year `rawdata` conversions, each independent) is embarrassingly parallel; a 16-vCPU box with `dvx run -j 16` eats it in a fraction of serial time.
- **No devbox**: the laptop handles today's incremental builds fine (pyramid = 156 s), so this is *not* a standing-infra ask — it's an on-demand, ~$1–3/run, zero-idle-cost capability, same as ctbk's.

## Shape

1. **Derived image**: `FROM dvx-batch:<rev>` + repo checkout + `uv sync`. Needs: python deps (`uv.lock`), *not* node/pnpm (www builds and deploys are excluded — below). Entrypoint inherits `dvx`.
2. **Creds**: S3 keys with rw on `s3://nj-crashes` (the DVX remote + `njdot/data` upload targets). No Cloudflare, no GitHub — excluded targets need them, and they're excluded.
3. **Submit** onto an **`audit` branch, committing regenerated hashes as levels pass** (the default — see Runbook). `dvx run --commit each --push each` on a checkout of `audit`: each stage's blob lands in the reproc S3 remote *and* its regenerated md5 is written back into the `.dvc` and pushed to `audit`. A crash or Spot reclaim then resumes from the last committed level instead of re-running everything (the round-1–10 run used `--no-commit` and paid for this — early levels re-ran ~10×, quadratic; see Retro FFR #1). Full-DAG-from-scratch off `main` stays available as a one-shot signal.

## Target set

~1,400 `.dvc` targets. Families, roughly by DAG depth:

| Family | Count | Notes |
|---|---|---|
| Raw leaves (NJDOT zips, NJSP XMLs, crime PDFs/XLSX) | ~200 | Fetch stages; `--force` should NOT re-download by default (upstream files rot/move; the 2001–2023 zips are immutable history). Reproc = regenerate *derived* targets; leaves stay pinned. |
| Per-year txt→pqt (`rawdata`) | ~1,000 | The EP fanout win: 25 years × ~5 tables, independent |
| Combined parquets (crashes/vehicles/occupants/pedestrians/drivers) | ~10 | Joins across all years; memory-heaviest stages |
| Harmonize, match, supplement, backfill, crash-log | ~10 | |
| Aggregates (cmymc, ymccmc*, csvs, projections, summaries) | ~15 | |
| Cells (s2 raw, cells-s2.db, s2_pyramid) | 3 | Pyramid is the one that OOMs a 7 GB GHA runner; fits easily in 64 GiB |
| **Excluded: side effects** | 8 | `api/d1-import`, `cells-api/deploy`, `www/deploy`, `www/og-image`, `njsp/data/slack_post`, `www/public/njdot/map_sync`, and the two fetch stages `njsp/data/{refresh,summaries}`. Deploys / notifications / upstream fetches, not data — reproc must never fire them. **Mechanism (resolved):** each is marked `meta.computation.side_effect: true`, a dvx-native flag; `batch/reproc-targets` derives the exclusion from it, so a stage's nature is declared once, in the stage. |

## Redirecting side-effect uploads (`$NJC_S3`)

Some stages publish to S3 as a *command side effect*, not as a tracked `outs`
— so they can't be excluded by dropping a target. The blocking case is
`njsp update_pqts --s3` (`njsp/data/crashes.parquet.dvc` +
`www/public/njsp/crashes.db.dvc`): its co-output parquet is needed by half the
downstream DAG, so the cmd runs regardless of which co-output is targeted, and
it would overwrite prod's `njsp/data/{crashes.parquet,crashes.db}`.

Every such URL in the pipeline derives from a single root, so one env var
redirects them all:

    NJC_S3=s3://nj-crashes/.reproc

`nj_crashes.paths.S3` reads it (default `s3://nj-crashes`); `njsp/paths.py`'s
`*_S3` constants and `njdot/paths.py`'s `DOT_DATA_S3` derive from it, and
`www/og-image.sh` mirrors it in shell. Pass it through with
`dvx batch submit -e NJC_S3=…`.

This redirects **reads** as well as writes, which is deliberate: `pqt_url`'s
S3 fallback (`njdot/data.py`) resolves under the same root, so a stage with an
undeclared per-year dep can no longer be silently rescued by the prod mirror —
it fails loudly instead. That fallback is exactly what masked the two dep-less
Level-1 stages (`njsp/data/muni_codes.parquet`, `www/public/njdot/crashes.db`)
on dev machines. Expect the audit to surface any remaining ones as
`FileNotFoundError` rather than a quiet success.

## Fanout analysis (EM)

- Per-year `rawdata pqt` ≈ 1–5 min each serially; 125 stage-instances / 16 workers ≈ **20–40 min** for the wide level.
- Combined parquets + downstream ≈ critical path of maybe 6–10 stages × 2–15 min ≈ **30–60 min**.
- Cells raw+db+pyramid ≈ 5 min (measured today).
- **Total: ~1–2 h wall on one 16-vCPU Graviton Spot task ≈ $1–2.** This is why Phase-1 single-job mode (dvx spec) is the right first build: multi-job fanout can't beat it by much when the wide level is already saturated at `-j 16`, and each extra job pays ~30–60 s Fargate startup.
- Revisit multi-job (Phase 2) only if: the wide level's stages turn out CPU-bound enough that 16 cores is the bottleneck (then 2–4 parallel jobs splitting the year range is trivial to express as targeted submits — no driver needed), or the combined-parquet stages need a bigger memory class than the rest.

## Spot-reclaim story

`--push each` makes every completed stage durable in S3 before the next starts; a reclaimed task's re-submit skips all of it (DVX freshness + auto-pull). Expected reclaim cost: one in-flight stage. `--on-demand` remains the knob for a guaranteed pass (~3× compute, still ~$5).

## Acceptance

- A from-scratch run (empty local cache, `--force` on derived targets) completes green and pushes byte-identical md5s for every DT stage; ND stages (if any surface) get documented as such in their `.dvc` comments — now durable, post `dvc-rewrite-fidelity`.
- Diverging md5s vs the current remote are *findings*, not failures — each is either a real IDP bug or an undeclared dep (exactly how `crashes_geocode_backfill.parquet` was caught, 2026-08-26).
- The excluded side-effect targets provably never ran (no D1 writes, no deploys, no Slack posts).

## Status (2026-08-26)

Implemented so far: `batch/Dockerfile` (self-contained; `FROM dvx-batch` swap pending their base image) + `batch/reproc.sh` (target enumeration + side-effect excludes). Local container smokes (arm64 Docker) validated: image build, `git_deps` hashing on a shallow clone, `dvx pull` materialization with static-key creds (`AWS_PROFILE=r`; SSO can't refresh headless). Smokes also surfaced and fixed/filed:

- `cc2mc2mn.json.dvc` co-output declared no deps → fixed (`8ba50782ecf`), and its blob (plus `s2_pyramid`, `cm.pqt`, census, `crashes.db` — 48 total, most git-covered) pushed to the remote after a full blob audit.
- DVX materialization race on fresh clones + `--force`/auto-pull interaction + incremental-stage self-dep (`crash-log -i`) → filed as "First-smoke findings" in `dvx/specs/batch-executor.md`.
- The `njdot/data/` S3 mirror (the `pqt_url` fallback in `njdot/data.py`) stops at 2022 — masked-by-fallback failures show up on fresh machines; consider dropping the fallback once reproc materialization is reliable.

Remaining: heavy smokes and the from-scratch run happen **on Fargate** (or `e`), not this laptop — blocked on dvx's `batch push|bootstrap|submit` landing, then: `FROM` swap, ECR push, bootstrap, first `submit --watch`.

## Open questions

- ~~Where the exclude list lives~~ **Resolved**: `meta.computation.side_effect: true` on the stage; `batch/reproc-targets` derives from it and `batch/reproc.sh` sources that, so there's one definition rather than two that drift. Note the *inferred* predicate (cmd, no `outs`) is not usable here — it misclassifies the co-output driver stages `njsp/data/harmonize.dvc` and `www/public/njsp/projections.dvc`, whose real outputs live in sibling `.dvc`s. Only the explicit flag distinguishes them. A dvx-side "skip side-effect stages unless explicitly targeted" default would subsume this script entirely; worth proposing once the flag is populated across repos.
- ~~Whether `refresh.dvc` counts as a leaf-pin or a side effect~~ **Resolved**: side effect. Both it and `summaries.dvc` carry `fetch.schedule`, fetch from upstream, and mutate tracked inputs — reproc pins, the daily refreshes.
- Whether `.dvc` should support env interpolation in `cmd`. **Answered: no.** dvx runs cmds via `subprocess.run(shell=True)` with the parent env, so `${VAR}` already expands — but `cmd` is not part of dvx's freshness key (`is_output_fresh` = out md5 ∧ recorded dep hashes), so an interpolated var is an entirely unrecorded input: a reproc under a redirected root would read every stage as fresh and silently verify nothing. `.dvc` stays a rendered lockfile; per-environment config lives in code behind `$NJC_S3`, and computation changes are mechanical rewrites reviewed as git diffs. If parameterization is ever genuinely wanted, the principled form is a *declared* `meta.computation.env: [NAME]` whose values hash into the freshness key.
- ECR account: RAC (where prod CF lives today) vs the new HCCS account — tie to the broader CF/AWS migration decision rather than deciding here.

## Runbook — default flow (commit hashes as you go)

The reproc runs in an **ephemeral** Fargate container, so any `.dvc` the run
reconciles must be pushed off-box or it dies with the task. Round 10 learned
this the hard way (`--no-commit` ⇒ blobs survived in S3, reconciled `.dvc`s did
not). The default is therefore:

1. Cut/reset an `audit` branch from the commit under test; push it.
2. Submit with the container checked out on `audit` and
   `dvx run --commit each --push each --remote reproc`, **and** an entrypoint
   wrapper that `git push`es `audit` after each level (needs a write token,
   passed via the env — inline env vars get stripped, so wrap it in a script).
3. On a crash/reclaim, re-submit the same command: dvx sees the levels already
   committed on `audit` (their regenerated md5s are recorded and their blobs are
   in the reproc remote), materializes them, and resumes at the first
   uncommitted level. No quadratic re-run of the early levels.
4. When green, the `audit` branch *is* the reconciled result — diff it against
   `main` to review every hash change (each is a finding: real IDP bug, undeclared
   dep, or benign writer/schema drift per `batch/pqt-audit`).

Reconciling an *already-finished* `--no-commit` run (as round 10 left things)
without recomputing: on `e`, download each target's blob from the reproc remote
by its `produced` md5 (from the run log) into the worktree, then `dvx commit`
— dvx hashes the worktree and writes the regenerated md5s + dep/dir hashes into
the `.dvc`s correctly. Push that as the `audit` branch. A subsequent re-run then
skips everything, which also validates the reconciliation (anything that
recomputes was captured wrong).

## Retro — the run happened (rounds 1–10, 2026-08-29)

Ten Fargate rounds took the full-DAG reproc from **14 Level-1 failures to 0 across all 8 levels**. `status: SUCCEEDED`, 160 targets, 0 `✗`. Failure trajectory by deepest level reached: L1→L1→L1→L1→L2→L3→L2→L3→L5→**L8**.

### Real bugs surfaced (all pre-existing, none cosmetic)

| # | Bug | How it hid |
|---|---|---|
| 1 | `Municipal_Boundaries_of_NJ.geojson` undeclared dep | runtime `dvc pull` shell-out |
| 2 | `census/data/raw/` (888 K) undeclared | committed `.gitignore` |
| 3 | `nj_sri_mp.db` (34 M) undeclared | global `*.db` excludesfile |
| 4 | `njdot/data/2023/crash_dupes/` undeclared | `.git/info/exclude` (repo-local) |
| 5 | `crash_log` self-referential input (own output was its only resume cursor) | worked incrementally, unbuildable from scratch |
| 6 | A class of cwd-relative path literals | only worked from repo root; `dvx run`'s per-artifact cwd broke them |
| 7 | **`crashes.parquet` persisted without `tk`/`ti`/VTC** | `load_tbl` wrote before `crashes.load` computed victim counts; committed file predated the write-order regression, so incremental never noticed |

\#7 was the headline: **current code did not reproduce its own committed output**, and the matcher / `three_way` / every `.db` silently depended on the dropped column. Exactly what a from-scratch audit exists to catch and nothing else would.

### Retired via new dvx capability

- `crash_log` → `git_log_deps` (depend on a pathspec's git history; dvx owns freshness, the stage reads `$DVX_GIT_LOG_SINCE` as its resume cursor). Killed the phantom self-dependency.
- `harmonize` `side_effect: true` durability — dvx now preserves author-set `meta.computation` across a co-output `.dvc` rewrite (was stripped by the daily's own run).
- `output hash changed` warning — the missing audit signal; its absence let a wrong "0 divergences" reading stand for three rounds.

### The 150 "hash changed" are not divergences

`batch/pqt-audit` classifies a changed md5 as `identical` / `metadata` (footer only) / `encoding` / `schema` / `content`. On this run: all `encoding`/`schema`, **zero `content`**. The recorded prod md5s are stale across three writer eras (pyarrow 12/20/21, the `cc0`/`mc0` schema addition) plus the `tk` restoration — `rawdata pqt` only reruns on annual NJDOT updates, so nothing regenerated them for eight months. Stale recorded hash ≠ non-reproducible pipeline.

## FFR — what to do differently next audit

### 1. Use an `audit` branch and commit regenerated hashes as levels pass

The run re-ran early levels ~10× (fresh container + prod-md5 mismatch ⇒ nothing materializes ⇒ everything recomputes every round). That is **quadratic** in the number of rounds and pushed `crash_log`'s ~29-min from-scratch walk onto the critical path of every single round.

The fix is not to trust prior output blindly — it's to **snapshot progress**. Cut an `audit` branch; each round, after a level passes, `dvx commit` the regenerated md5s onto it (and push the blobs to the reproc remote). The next round's fresh container checks out that branch, and passed levels are then genuinely fresh — materialized by the *now-recorded* (regenerated) md5, which *is* in the reproc remote. Iteration collapses to "re-run only the level you're fixing, forward." The clean full-DAG-from-scratch signal is still available on demand (a single run off `main`), but you pay for it once, not once per bug. The earlier framing here — that non-skipping is inherently "what we want" — was wrong; re-verifying L1 ten times bought nothing and made L5+ slow to reach.

### 2. `crash_log` from-scratch is ~29 min of mostly-parallelizable serial work

The walk is sequential (backward over 1,351 FAUQStats-touching commits), but the *expensive* part per step — reading and XML-parsing FAUQStats blobs — is independent and highly redundant: ~3,126 unique blob SHAs sit behind ~25k blob-references (~8× dedup), and the diff/accumulate on already-parsed dicts is cheap. Naive impl is single-threaded GitPython (slow at tree/blob traversal) re-parsing per commit. Speedup path, largest first:

1. **Bulk blob extraction** via `git cat-file --batch` (one pipe streams every needed blob) instead of per-blob GitPython `data_stream` — GitPython's pure-Python tree walk is the dominant cost.
2. **Memoize parse by blob SHA** — parse each of the ~3,126 unique XMLs once, not once per commit that references it.
3. **Parallelize** the unique-blob parse across cores (`joblib`), then run the cheap sequential diff over the parsed cache.

Plausibly minutes, not half an hour. Worth doing regardless of the audit — the daily's incremental path parses far fewer blobs but shares the slow GitPython access.

### 3. Resource-aware scheduling belongs in dvx, not a per-stage memory ceiling

The one OOM (`crashes.db`, exit 137) was **Level 5 running ~9 heavy pandas/sqlite builds in parallel on one 64 GB container**. The blunt fix used here was to lift the *whole job* to the 120 GB Fargate ceiling — every stage pays for the peak of the heaviest. The right fix is for stages to declare resource needs and the scheduler to pack a level by them. Filed as a dvx direction: `~/c/dvx/specs/resource-aware-scheduling.md`.
