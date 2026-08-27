# Batch reproc: rebuild every DVX target from scratch on Fargate Spot

Companion to `~/c/dvx/specs/batch-executor.md` (the reusable `dvx batch` tooling, requested 2026-08-26). This spec is the nj-crashes side: what a full-DAG reproc of this repo looks like on AWS Batch, following the pattern ctbk + pyrmts validated in July (`pyrmts/specs/done/engine-batch-packaging.md`).

## Motivation

- **r13y**: prove the whole pipeline regenerates from raw inputs. Today the only full-reproc venue is a laptop; CI runs incremental slices, and the one full-rebuild-shaped incident this week (the `--grid` cmd rot in `data/cells/*.dvc`) went undetected for a month because nothing ever re-executed those cmds.
- **Wall-time**: the DAG's wide middle (~25 years × ~5 tables of per-year `rawdata` conversions, each independent) is embarrassingly parallel; a 16-vCPU box with `dvx run -j 16` eats it in a fraction of serial time.
- **No devbox**: the laptop handles today's incremental builds fine (pyramid = 156 s), so this is *not* a standing-infra ask — it's an on-demand, ~$1–3/run, zero-idle-cost capability, same as ctbk's.

## Shape

1. **Derived image**: `FROM dvx-batch:<rev>` + repo checkout + `uv sync`. Needs: python deps (`uv.lock`), *not* node/pnpm (www builds and deploys are excluded — below). Entrypoint inherits `dvx`.
2. **Creds**: S3 keys with rw on `s3://nj-crashes` (the DVX remote + `njdot/data` upload targets). No Cloudflare, no GitHub — excluded targets need them, and they're excluded.
3. **Submit**: `dvx batch submit --force` (full reproc) or targeted subtrees. `--commit never --push each` per the dvx spec: outputs land in the S3 remote; `.dvc` reconciliation happens afterward on a dev machine via a plain `dvx run` (all fresh, auto-pull) + `/commits`.

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
| **Excluded: side effects** | ~6 | `api/d1-import`, `cells-api/deploy`, `www/deploy`, `slack_post`, `og-image`, `refresh` (mutates upstream state). These are deploys/notifications, not data — reproc must never fire them. Mechanism: an explicit exclude list in the submit wrapper, or run named data-root targets instead of the bare-`dvx run` everything mode. |

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

- Where the exclude list lives: submit-wrapper flag vs a `.dvxignore`-style repo file vs a convention (side-effect stages already lack `outs`; "skip side-effect stages unless explicitly targeted" may be the cleanest rule and belongs dvx-side).
- Whether `refresh.dvc` (NJSP XML fetch) counts as a leaf-pin or a side effect — it mutates tracked inputs; reproc should pin, daily CI refreshes.
- ECR account: RAC (where prod CF lives today) vs the new HCCS account — tie to the broader CF/AWS migration decision rather than deciding here.
