# Retire RAC: move remaining crashes infra to HCCS

Goal: nothing crashes-related left in the RAC accounts (AWS `006196295121` / profile `r`; CF `0dcad…`), so they can be cut away from. HCCS equivalents: AWS `688066488567` (profile `h`), CF `2363642879f18d37d52dca114059937e` (via `infra/hccs-run`).

This builds on [pulumi-cf-infra] (CF Workers/D1/Pages/domains; the "window 1/2" D1 seeding) and [s3-to-r2-hccs] (data → HCCS R2 `crashes`). Those did the data and FE halves; this spec tracks the rest.

Storage principle (2026-09-25): **R2 is the system of record** for public artifacts and interesting intermediates. AWS is compute only; S3 holds no pipeline data. Fargate reads R2 via `public` (anonymous, free egress) and writes with `-r r2`. AWS→R2 egress is ~$0.09/GB, well under 1 GB for a targeted rebuild and a few dollars for a full reproc.

## Inventory (2026-09-26, read-only)

Both RAC accounts are shared with other projects (ctbk, awair, pyrmts, marin, …). Only crashes items are listed.

### RAC AWS

| Resource | State | Depended on by |
|---|---|---|
| Batch `nj-crashes` queue, `nj-crashes-spot` CE, job defs `nj-crashes` (audit) + `nj-crashes-reproc`, roles `nj-crashes-batch-{execution,task}`, log groups `/nj-crashes{,-reproc}/batch` | **live**; Pulumi `batch/infra` stack `dev` | reproc/rebuild runs ([reproc-infra-iac]) |
| ECR `nj-crashes-reproc` | live, Pulumi-`protect`ed | the Batch job defs |
| Secrets Manager `nj-crashes/fargate-github-rw-token` | live | reproc push-back |
| S3 `nj-crashes` (100.6 GiB): `.dvc/` (legacy DVX remote `s3`), `.dvc-reproc/` (remote `reproc`), `.reproc/`, `.audit-scratch/`, `njdot/`, `njsp/`, `pulumi/` (batch stack state), `og.jpg` | legacy except `.dvc-reproc/` and `pulumi/`, which the Batch stack still uses | `.dvc/config` remotes `s3`/`reproc`; code defaults below |
| Lambda `njsp-crashes` (+ function URL, role `njsp-crashes-lambda-role`, log group) | ~~dead~~ **deleted 2026-09-26** (0 invocations in 90d, no repo refs) | — |
| IAM user `nj-crashes-GHA` (2 active keys) | key last used 2026-09-12 (the R2 cutover) | GH secrets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, no longer referenced by any workflow |
| IAM user `nj-crashes-s3ro` + policy `s3-nj-crashes-ro` | ~~dead~~ **deleted 2026-09-26** (last used 2025-06-30) | — |
| EC2 `e` (`i-06708b0d46a8ac2a4`, `m6g.4xlarge`, 320 GB EBS) | stopped; **sunset for crashes** (2026-09-26) | was the de facto devbox; shared with ctbk (named "ctbk"), so the instance itself is ctbk's call |
| Batch `dvx` queue/CE/job def (41 revisions), `/dvx/batch` | shared-dvx era; [reproc-infra-iac] step 5 "retire" | nothing in crashes |

### RAC CF

| Resource | State | Depended on by |
|---|---|---|
| Worker `crashes-api` (`crashes-api.ryan-0dc.workers.dev`) | **live, prod** | FE `VITE_API_URL` (`www/deploy.sh`, `www/dev-restart.sh`, `www/og-image.sh`) |
| D1 `crashes` (3.0 GB), `vehicles` (1.2 GB), `occupants` (971 MB), `pedestrians`, `cmymc`, and **`njsp-crashes-staging-20260507-124828`** (`dc1d62db`) | **live, prod**. The NJSP DB's live copy is the one *named* staging: a May staging-swap left `api/wrangler.toml`'s `njsp-crashes` binding pointing at it. The plainly-named `njsp-crashes` (`f0ff5e40`) is an orphan. | `crashes-api`; daily `api/d1-import.dvc` → `njsp-crashes` (daily `CLOUDFLARE_*` secrets are RAC) |
| Worker `crashes-cells-api` (`crashes-cells-api.ryan-0dc.workers.dev`) | superseded by HCCS (2026-09-12) | `njdot/cli/tune.py` `CELLS_API` default; `www/tmp/*.sh` |
| D1 `cells-s2`, `cells` (old grid), `tune` | superseded | RAC `crashes-cells-api` only |
| D1 `*-staging-20260414-*` ×7 | ~~garbage~~ **deleted 2026-09-26** (~4.4 GB) | — |
| D1 `njsp-crashes` (`f0ff5e40`) | orphan (see above) | — |
| R2 `nj-crashes` | superseded by HCCS `crashes` (parity-verified 2026-09-11) | `scripts/mirror_*_to_r2.sh` `R2_ENDPOINT` defaults |
| Pages `nj-crashes` | **already deleted** (404) | — |

### Already on HCCS

- CF: Pages `crashes` (prod FE; `crashes.hccs.dev` + `crashes.hudcostreets.org`) and `crashes-dev` (`dev.crashes.hccs.dev`); worker `crashes-cells-api` (`crashes-cells.hccs.dev`); R2 `crashes` (`crashes-data.hccs.dev`); D1 `cells-s2`, `tune`.
- D1 window 1 seeded: `crashes` (2.1 GB), `occupants` (712 MB), `pedestrians`, with a trimmed schema, so sizes are smaller than RAC's. **Window 2 is not done**: HCCS `vehicles`, `cmymc`, `njsp-crashes` are empty. It was due after the Sep 24 D1 usage reset.
- Daily writes: DVX `-r r2`, `NJC_S3` → R2, og → R2 (GH secrets `R2_HCCS_RW_*`).

## Plan

Each phase ends in a verified state; RAC deletions all come last (phase 5), after green days.

### 1. Batch → HCCS AWS ✅ (2026-09-26)

**Done.** Stack `hccs` is live: 14 resources in AWS `688066488567`, with state committed under `batch/infra/state/` (passphrase-encrypted; only the ECR login token is a state secret). Secrets `nj-crashes/{github-rw-token,r2-access-key-id,r2-secret-access-key}` were filled by `batch/infra/put-secrets`. Validated with job `7d8f7c1e` (`AWS_PROFILE=h batch/submit … run -r r2 … data/cells/cells-s2.db.dvc`): it pulled from R2, the stale-on-this-branch stages re-ran and pushed to R2, and the results branch pushed back. `cells-s2.db` was up to date, and `njsp_njdot_residuals` came out byte-identical to the RAC run's (`e15cf95f`). Remaining RAC-side cleanup is in phase 5.

Original plan:

Same `batch/infra` program, new stack `hccs` in account `688066488567`:

- **Pulumi state**: local file backend committed to git, matching `infra/` (decided 2026-09-26). No bootstrap bucket; the stack stores no secret values.
- **ECR** `nj-crashes-reproc` (new, Pulumi-created), image built by the existing `docker_build.Image` path.
- **Secrets**: `nj-crashes/github-rw-token` (copy from RAC, value never printed) and `nj-crashes/r2-rw` (`R2_HCCS_RW_*` keys). The job defs inject them as `FARGATE_GITHUB_RW_TOKEN` and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` + `AWS_ENDPOINT_URL_S3` (R2).
- **Task role**: no S3 grants; data goes via R2 keys.
- `batch/entrypoint.sh`: `dvx run -r r2`; pulls via `public` need no creds.
- `batch/submit`: `AWS_PROFILE` per stack (or document `AWS_PROFILE=h`).
- **Validate**: re-run the `cells-s2.db` target (nothing stale → a no-op run proves pull + push-back), then a forced single-stage rebuild with byte-identical output.

### 2. D1 window 2 + `crashes-api` → HCCS ✅ (2026-09-26)

**Done.** Daily run `36240169062` (manual dispatch on `18fffb5a06f`) ran `d1-import` against HCCS; all three stamps (`njsp-crashes`, `cmymc`, `cells-s2`) match `main`'s deps, so it was a no-op import. It also deployed the FE. Checked in the browser on `crashes.hccs.dev`: every API call (8 on `/`, `/njdot/crash` on a crash page) goes to `crashes-api.hccs.dev` with 200s, and the NJSP recent-crashes, year-stats, NJDOT crashes (with vehicle/victim children) and crash-detail views all render. RAC `crashes-api` and its D1s are now unused, so they move to phase 5 after green days. The RAC `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets are also unused now; delete them in phase 5.

**Details:**
- Window 2 seeded into HCCS: `njsp-crashes` (15,141 rows), `vehicles` (12,375,667 rows), `cmymc` (all 12 tables), 29.3M writes. Window 1's `crashes`/`occupants`/`pedestrians` verified current (their `_metadata.source_md5` = `main`'s `.dvc` md5s). The local `.db`s were stale pre-trim copies; `dvx pull --force` fixed that before seeding.
- `api/wrangler.toml` → HCCS ids (committed); `crashes-api` deployed to HCCS; `crashes-api.hccs.dev` custom domain via `infra/` Pulumi (`deployed_workers`). Its responses match RAC's for NJSP and child tables; NJDOT crashes are a newer build (+98 rows, +29 per-victim-type columns).
- `VITE_API_URL` → `https://crashes-api.hccs.dev` (`www/deploy.sh`, `dev-restart.sh`, `og-image.sh`); daily + `cf-worker-errors` `CLOUDFLARE_*` → HCCS (`CF_HCCS_INFRA_TOKEN` + literal account id). The probe had been watching the dead RAC `crashes-cells-api` since 2026-09-12.
- `d1-import.sh` fetches the prior `.db` from the public remote (was RAC S3, which CI couldn't reach, forcing full re-imports whenever the prior wasn't cached).
- Cutover lands via a manual `daily.yml` dispatch, so the real pipeline does the FE deploy and the HCCS `d1-import`.

Original plan:

Per [pulumi-cf-infra] "Window 2":

1. Seed HCCS `vehicles`, `cmymc`, `njsp-crashes`: `python3 infra/hccs-run bash api/scripts/d1-import.sh --inplace --full <db>`. The laptop is fine for the import itself (it's a deploy step, not `dvx run`), but pull the `.db`s rather than building them.
2. Retarget `api/wrangler.toml` to the HCCS `database_id`s (commit it this time; the spec notes `e`'s copy was left uncommitted), deploy `crashes-api` to HCCS, and add the `crashes-api.hccs.dev` domain (Pulumi `deployed_workers` gate).
3. Repoint `VITE_API_URL` → `https://crashes-api.hccs.dev` in `www/deploy.sh`, `www/dev-restart.sh`, `www/og-image.sh`; deploy the FE; check prod in the browser (crash tables, plots, `/c/…` pages).
4. The daily: `api/d1-import.dvc` → HCCS `njsp-crashes`. Swap GH secrets `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` to HCCS values (or have the stage use `CF_HCCS_INFRA_TOKEN`, which already exists). The same secrets feed `cf-worker-errors.yml`, which then monitors HCCS workers.
5. Watch the first daily run go green end to end.

### 3. Code defaults → HCCS

- `nj_crashes/paths.py` `NJC_S3` default and `www/og-image.sh` `S3_ROOT` → R2 (`s3://crashes` + R2 endpoint), so nothing depends on the daily's env override.
- `api/scripts/d1-import.sh` `DVC_S3_PREFIX` (prior-`.db` fetch for exact-diff) → `public` HTTP.
- `njdot/cli/tune.py` `CELLS_API` → `https://crashes-cells.hccs.dev`.
- `scripts/mirror_*_to_r2.sh`: one-shot RAC→R2 migration scripts, so delete them (history keeps them).
- `.dvc/config`: drop remotes `s3` and `reproc` (after phase 1 moves reproc to `r2`).

### 4. Devbox (decided 2026-09-26)

`e` is **sunset for crashes**: don't push to it or run there. Pipeline work runs on Batch (phase 1). If an interactive node is needed later, spin up a new one in HCCS EC2 (Pulumi-declared, stopped by default) at that point.

### 5. Retire RAC (each deletion confirmed with the user first)

- ~~**Now (no dependents)**: the 7 staging D1s; Lambda `njsp-crashes` + role; IAM user `nj-crashes-s3ro`.~~ Done 2026-09-26; prod `crashes-api` smoke-tested after.
- **After phase 1**: `pulumi destroy` the RAC `dev` batch stack (unprotect ECR first); delete secret `nj-crashes/fargate-github-rw-token`; S3 `nj-crashes/.dvc-reproc/`, `.reproc/`, `.audit-scratch/`, `pulumi/`.
- **After phase 2 + green days**: RAC workers `crashes-api`, `crashes-cells-api`; RAC D1s `crashes`, `vehicles`, `occupants`, `pedestrians`, `cmymc`, `njsp-crashes-staging-20260507-124828` (live NJSP), `njsp-crashes` (orphan), `cells-s2`, `cells`, `tune`; R2 `nj-crashes`.
- **After phase 3**: IAM user `nj-crashes-GHA`; GH secrets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
- **Last**: S3 `nj-crashes` (100.6 GiB). First, a blob-parity check that every md5 under `.dvc/files/md5/` is in R2 `crashes/.dvc/files/md5/` (the 2026-09-11 copy was 60 GiB; anything in `.dvc` that R2 lacks gets copied or explicitly dropped). `njdot/` and `njsp/` are superseded by R2 (see [s3-to-r2-hccs]).

## Decisions

1. **Pulumi state for `batch/infra` on HCCS**: committed local file backend, like `infra/`.
2. **Devbox**: `e` sunset for crashes; a new HCCS EC2 node when one is next needed.
3. **Other HCCS-owned things in RAC** (S3 `hudcostreets` `hbt/`/`path/`, RAC Pages `hccs-funds`): out of scope; those projects handle their own moves.

[pulumi-cf-infra]: pulumi-cf-infra.md
[s3-to-r2-hccs]: s3-to-r2-hccs.md
[reproc-infra-iac]: reproc-infra-iac.md
