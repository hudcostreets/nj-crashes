# Spec: Pulumi for Cloudflare infra (crashes) + HCCS standup

Bring the crashes **Cloudflare** stack (R2 + Workers + D1 + Pages + custom domain)
under Pulumi, then use it to stand up a canonical copy in the **HCCS** account —
replacing the ad-hoc dashboard/wrangler + hand-edited-script cutover.

Supersedes the manual playbook steps in [`s3-to-r2-hccs.md`](s3-to-r2-hccs.md) for
crashes (that file's provisioned-resource coords + credential table still apply).

## References
- **ctbk** already did this (the pattern to mirror): `$c/hccs/ctbk/infra/`
  (`__main__.py`, `Pulumi.yaml`, `Pulumi.hccs.yaml`) + `ctbk/specs/pulumi-cf-infra.md`
  + `.github/workflows/infra-drift.yml`. Cross-check ctbk's recent session/`tmp/pulumi-hccs-*`
  for standup gotchas before running `pulumi up`.
- **crashes** already uses Pulumi for AWS: `batch/infra/` (`pulumi_aws`, Fargate
  reproc; `specs/reproc-infra-iac.md`). This CF stack is separate.
- Provider: `pulumi-cloudflare >= 6.14.0` (has `R2Bucket`, `R2CustomDomain`,
  `R2BucketCors`, `R2ManagedDomain`, `R2BucketEventNotification`, `D1Database`).

## Decisions (locked)
- **Move EVERYTHING to HCCS** — both Workers (`crashes-cells-api` + `crashes-api`)
  and all their D1 DBs, not just cells-api. Full consolidation; RAC's only future is
  deletion once cut away from (no `rac` import stack).
- **Custom public domain: `crashes.hccs.dev`** (`hccs.dev` is a CF zone in HCCS →
  `R2CustomDomain` attaches with no DNS/zone work). Aspiration: nice custom domains
  for the Workers/APIs too — under `hccs.dev` (see naming below).
- **D1 cutover is transparent** — export/import every D1's data (incl. `tune`'s user
  votes) so users/me see no gap.
- **Keep the interim `pub-f247f516…r2.dev`** through the transition; disable at RAC
  retirement.
- **Approach: IaC-first.** Pulumi owns CF *resources* + Worker *bindings*; wrangler
  stays authoritative for Worker *code*. Stand up the HCCS copy via `pulumi up`,
  then cut over; keep prod (RAC/S3) live throughout, retire after green days.
- **Backend:** Pulumi local file backend committed to git, `PULUMI_CONFIG_PASSPHRASE`
  -encrypted (ctbk pattern) — `infra/state/`. (crashes' *batch* infra uses an S3
  backend; the CF stack follows ctbk for cross-project consistency.)

## Standup status (2026-09-11) — `pulumi up` GREEN
`infra/` stack `hccs` applied (11 created, 1 imported). Verified: `crashes.hccs.dev`
serves HTTPS 200 (cert provisioned), ranged CORS 206 with `allow-origin:*` + exposed
headers. Run the stack only via `infra/pul` (sets `CLOUDFLARE_API_TOKEN=$CF_HCCS_INFRA_TOKEN`);
bare `pulumi` picks up the RAC token from `.envrc` → 403.

- **hccs.dev zone id:** `584473ace73a57527f4c093c9e2a49f8`
- **Pulumi token:** `crashes-infra` (account: R2/D1/Workers Scripts Edit; zone hccs.dev:
  DNS Edit, Zone Read, Workers Routes Edit) → `.envrc` `CF_HCCS_INFRA_TOKEN`.
- **New HCCS D1 `database_id`s** (for the wrangler.tomls):
  `cells-s2` 5f3f02b6-4ff6-439d-be66-a9d1436c649b ·
  `tune` b9eea284-d436-4045-bb3b-c30ebf53f9b7 ·
  `crashes` 2960b2cd-4baa-42ab-aaeb-bf3867ea5433 ·
  `vehicles` 21091342-2c9e-4b69-bf11-2b4ec098e4c6 ·
  `occupants` 8fc968db-4a84-4bc2-8130-3359003a0ccc ·
  `pedestrians` f06cc3cc-e40e-4a6b-b1dd-64157a9fb6b6 ·
  `cmymc` 5afec3ab-91b7-4d1f-a34e-6e81f00c2e6b ·
  `njsp-crashes` d29fda93-ed68-4229-a2b9-da55460e80a1
- Next: data copy (map/og) → D1 export/import → worker redeploys → FE/write repoint.

## DNS facts (verified 2026-09-11)
- **`hccs.dev` = CF zone in HCCS.** Use it for all custom domains (data + workers).
- **`hudcostreets.org` = Google Cloud DNS, NOT Cloudflare.** `crashes.hudcostreets.org`
  is a Google-DNS CNAME → `nj-crashes.pages.dev`. The FE site domain **stays** — just
  re-CNAME it to the new HCCS Pages project (no zone move). Don't put data/worker
  custom domains under `hudcostreets.org` (would need a full zone move).
- The two `.claude/`-config hostnames were **stale** (both NXDOMAIN):
  `nj-crashes-cells.hudcostreets.workers.dev`, `www.nj-crashes.com` — delete those refs.

### Custom-domain naming (under `hccs.dev`)
**All first-level** — CF Universal SSL only covers apex + `*.hccs.dev` (one label);
`*.crashes.hccs.dev` (two-deep) would need paid Advanced Cert Manager. So keep every
custom hostname one label deep:
- Data (R2): **`crashes.hccs.dev`**.
- cells+raw Worker: **`crashes-cells.hccs.dev`**.
- njsp D1 API Worker: **`crashes-api.hccs.dev`**.
- FE Pages: keep **`crashes.hudcostreets.org`** (re-CNAME to HCCS Pages).

## Current topology (what we're consolidating)
Three stores today, all effectively named `nj-crashes`:
1. **RAC R2** `nj-crashes` (`pub-170b5acc…r2.dev`, acct `0dcad`) — `raw/` + `cells/`.
   Read by cells-api Worker + FE raw-download. ✅ already copied → HCCS `crashes`.
2. **AWS S3** `nj-crashes` — `njdot/map/` + `og.jpg` (FE direct reads), **plus** the
   DVX cache / NJSP-internal parquets / batch-Pulumi state.
3. **Workers** `crashes-cells-api` (R2 `CELLS_BUCKET` + D1 `cells-s2`,`tune`) and
   `crashes-api` (D1), both in **RAC** `0dcad`. R2 + D1 are account-scoped.

Config funnels through one root: `NJC_S3` (`nj_crashes/paths.py`) + `R2_BUCKET`/
profile defaults (`njdot/cli/cells.py`, `scripts/mirror_*`), so the repoint is a
handful of edits.

## Scope
**IN — the FE/Worker public stack → canonical in HCCS:**
- R2 `crashes` bucket (imported), `crashes.hccs.dev` custom domain, CORS.
- D1 `cells-s2`, `tune` (recreated in HCCS).
- `raw/`, `cells/`, `njdot/map/`, `og.jpg` canonical in HCCS `crashes`.
- Workers `crashes-cells-api` (+ `crashes-api`) redeployed against HCCS.
- FE reads + write-side scripts repointed to `crashes.hccs.dev` / HCCS RW.

**OUT — deferred (heavier, tangled with AWS reproc infra):** the DVX cache
(`.dvc`/`.dvc-reproc`), NJSP-internal S3 parquets/dbs, batch/Pulumi state, and the
e2e test's public S3 fetch. These stay on AWS S3 for now.

## `infra/` layout (mirror ctbk)
```
infra/
  Pulumi.yaml            # name: crashes-infra; backend: file://./state
  Pulumi.hccs.yaml       # stack: HCCS acct (cloudflare_account_id secure)
  Pulumi.rac.yaml        # stack: import existing 0dcad resources (Phase 2, drift)
  __main__.py            # R2 bucket + custom domain + CORS + D1; workers documented
  requirements.txt       # pulumi, pulumi-cloudflare>=6.14
  state/                 # local backend, committed, encrypted
  README.md
```
`account_id = env CLOUDFLARE_ACCOUNT_ID or config.require_secret('cloudflare_account_id')`.
Run the `hccs` stack with an **HCCS-scoped** `CLOUDFLARE_API_TOKEN`.

### Resources (hccs stack)
- `cf.R2Bucket('crashes', import_='<hccs>/crashes/default', protect=True)` — adopt
  the bucket already created 2026-09-10.
- `cf.R2CustomDomain` — `crashes.hccs.dev` on the `hccs.dev` zone (creates the CNAME).
- `cf.R2BucketCors` — `GET,HEAD`; origins `*`; allow `Range,Authorization`; expose
  `Accept-Ranges,Content-Range,Content-Length,Content-Encoding,ETag` (playbook §3).
- `cf.D1Database` for **every** D1: `cells-s2`, `tune` (cells-api) + `njsp-crashes`
  and the njdot DBs (crashes-api). See **D1 migration strategy** below.
- `cf.R2ManagedDomain` — keep the interim `pub-f247f516…r2.dev` during transition;
  disable at RAC retirement.
- `cf.WorkersCustomDomain` — `crashes-cells.hccs.dev` (cells-api),
  `crashes-api.hccs.dev` (njsp API); first-level for Universal-SSL coverage.
  (Provider has `workers_custom_domain`.)
- Workers scripts: **documented, wrangler-deployed** (bindings reference the above).

## D1 migration strategy (cost-driven; 2026-09-11)

D1 bills **rows written incl. index rows** ($1/M over 50M/mo included, Workers Paid).
A naive full re-seed = **149M writes ≈ $99**. HCCS is on Workers Paid; **usage resets
on the 24th** (fresh 50M/window). RAC's allowance can't cover HCCS writes (separate
accounts) — but HCCS's window starts empty.

**Index audit (EXPLAIN vs `api/src/index.ts` queries):** of `crashes`'s 8 indexes,
only **2 are used** — `dt_severity` (main list/count, forced `INDEXED BY`) and
`cc_mc_severity_dt` (crash-detail `cc,mc`). Dead: `cc_severity_dt`, `crashes_if_dt`,
`severity_dt_cc_mc`, `severity_icc_dt`, `severity_ilat_ilon`, `ix_crashes_id`.
Child tables (`vehicles`/`occupants`/`pedestrians`) are only queried by `crash_id`,
so their `ix_*_id` (pandas `to_sql` auto-index on the `id` index) is dead too.

**Refactor (proper, benefits every rebuild + storage):**
- `njdot/cli/base.py` `CRASH_IDXS` → keep only `dt_severity` + `cc_mc_severity_dt`.
- `id INTEGER PRIMARY KEY` (rowid) on crashes/vehicles/occupants/pedestrians — needs
  explicit table DDL (pandas `to_sql` can't declare a PK; `sql.py:58`), which also
  removes the `ix_*_id` auto-index for free + gives fast id lookups. TFFP: rebuild
  a DB locally, assert schema (id PK, 2 crashes indexes) + EXPLAIN + row parity.
- Result: **149M → ~83M** writes (crashes 59→20M, occupants 45→30M, vehicles 37→25M).

**Seeding (transparent, ~$0):** derived DBs rebuilt in HCCS via `d1-import.sh`
(identical rows — not multi-GB SQL replay); `tune` votes via `wrangler d1 export`→
import. Split ~83M across **2 reset windows** (≤50M now + ≤50M after Sep 24) = **$0**.
E.g. window 1: occupants (30M) + crashes (20M); window 2: vehicles (25M) + the rest.

**Staging — keep RAC serving meanwhile:** each worker binds only its own account's
D1s, and the FE addresses each by its own base URL, so cut over **per worker** as its
DBs land: `cells-api` (+ R2 data) → HCCS now; `crashes-api` **stays on RAC** (its
RAC URL, RAC njdot D1s) until its 6 DBs are seeded in HCCS, then flip `VITE_API_URL`.

## Seed progress (2026-09-11/12)

**Window 1 seeded into HCCS D1 + verified** (trimmed schema — `id INTEGER PRIMARY KEY` + minimal indexes):
- `pedestrians` — 193,109 ✓
- `occupants` — 14,905,918 ✓
- `crashes` — 6,567,550 ✓ (2 indexes `cc_mc_severity_dt`,`dt_severity`; 3 writes/row confirmed)

`crashes.db` gotcha (fixed, commit `dc1d9213de7`): it was **stale — the OLD fat schema** (7 indexes, `id BIGINT`). Root cause: `www/public/njdot/crashes.db.dvc` has **no `git_dep` on the builder code**, so the index-trim commit (`bc7b53b8cdb`) never invalidated it (only dep `crashes.parquet` was unchanged). Rebuilt trimmed; `sql.py` `to_sql` gained `chunksize=100_000` (the wide 6.5M-row insert OOM'd a 61 GB box without it). **Gap-closer TODO:** give every `.db` `.dvc` a `git_dep` on its builder (`njdot/cli/base.py`, `nj_crashes/utils/sql.py`) so code changes invalidate them — same class as the missing D1-propagation edge.

Cost note: ~$8 over w1's free 50M — a killed fat-`crashes` attempt burned ~9.6M writes before the stale schema was caught.

**Operational how-to (for window 2 + cutover):**
- Devbox `e` = EC2 `i-06708b0d46a8ac2a4` ("ctbk", RAC acct, `m6g.4xlarge`), **STOPPED** 2026-09-12 (EBS preserved). Start: `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY AWS_PROFILE=r aws ec2 start-instances --instance-ids i-06708b0d46a8ac2a4` (HCCS admin creds in `$hccs/.envrc` override `AWS_PROFILE`, so unset them for RAC-account ops — same fix as `ei`).
- wrangler needs **node ≥22** — `e` default node is 18; use nvm's v24: `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`.
- Seed cmd (HCCS creds via wrapper, no token in shell): `python3 infra/hccs-run bash api/scripts/d1-import.sh --inplace --full <db>` — runs from `e` where the `.db`s live.
- `e`'s `api/wrangler.toml` is **retargeted to HCCS `database_id`s but UNCOMMITTED** — a `grhh` on `e` reverts it, so redo the sed (HCCS ids in "New HCCS D1 database_id`s" above) after any reset before seeding.

**Window 2 (after Sep 24 reset):** `vehicles` (~25M) + `cmymc` + `njsp-crashes`; plus `cells-s2` + `tune` for the cells-api cutover. Then worker deploys → FE/write repoint → per-worker cutover.

## Cutover sequence (prod stays live)
1. **Finish the data copy:** `njdot/map/` + `og.jpg` (AWS S3 → HCCS `crashes`;
   cross-account, RAC/AWS-read + HCCS-RW). `raw/`+`cells/` already parity-verified.
2. **`pulumi up --stack hccs`:** bucket (import) + `crashes.hccs.dev` + CORS + D1s.
   Verify `https://crashes.hccs.dev/<key>` GET 200 + CORS headers.
3. **Redeploy Workers against HCCS:** `crashes-cells-api` (+ `crashes-api`) via
   wrangler with HCCS token/account; `wrangler.toml` `bucket_name='crashes'` +
   new D1 `database_id`s from Pulumi outputs. Re-import `cells-s2` (from
   `cells-s2.db` via `d1-import.sh cells-s2`); `tune` starts empty (or export/import
   votes — see open Qs). New worker URLs → `crashes-cells-api.<hccs>.workers.dev`.
4. **Repoint FE** (`www/deploy.sh` + `config.ts`/`api.ts` defaults):
   `MAP_BASE_URL`, `RAW_PUBLIC_BASE_URL`, og URLs → `https://crashes.hccs.dev`;
   `VITE_CELLS_API_BASE`/`VITE_API_URL` → the HCCS worker URLs. HEAD-503 check for
   the ~280 MB map parquets (playbook §6: keep ranged reads, pass known byteLength).
5. **Repoint writes → HCCS RW:** `NJC_S3` + `R2_BUCKET`/profile defaults so
   `cells push`, `mirror_*`, `njdot map sync`, `og-image.sh` write HCCS `crashes`.
6. **CI:** `daily.yml` / `www/deploy.sh` / cells-api deploy → HCCS account/token for
   the moved Workers + Pages (keep AWS `AWS_*` secrets for the still-on-S3 DVX cache).
7. **Verify + retire:** re-sync to catch drift, deploy, watch CI green, **CIC prod**
   (network panel: blobs from `crashes.hccs.dev`, GET 200, no 503). Leave RAC R2 +
   S3 public blobs intact a few green days, then retire.

## GHA
Add `.github/workflows/infra.yml` reusing `Open-Athena/pulumi/.github/workflows/pulumi.yml@v1`
(PR = preview, push = up), `working-directory: infra`. Secrets: `PULUMI_CONFIG_PASSPHRASE`
+ an HCCS-scoped `CLOUDFLARE_API_TOKEN`. Optional `infra-drift.yml` (ctbk has one).

## Also repoint (config, not data)
- `.claude/hooks/auto-approve.yml` + `.claude/settings.local.json` hardcode the old
  host/bucket (`nj-crashes.s3.amazonaws.com`, `pub-170b5acc…`, `s3://nj-crashes/…`,
  worker/pages names) — update the AA rules post-cutover.
- `www/dist/*` embeds old URLs but is a `pnpm build` output — regenerates, no manual edit.

## Resolved (was open questions)
1. **`crashes-api` too?** ✅ Yes — move both Workers + all D1s (full consolidation).
2. **`tune` votes:** ✅ export/import (transparent); same for the other D1s.
3. **`rac` import stack:** ✅ skip — RAC is retired (deleted) after cutover.
4. **Managed r2.dev domain:** ✅ keep during transition, disable at retirement.
5. **Mystery hostnames:** ✅ both stale (NXDOMAIN) — delete the `.claude/` refs. Custom
   domains go under `hccs.dev`; FE stays `crashes.hudcostreets.org` (Google DNS).
