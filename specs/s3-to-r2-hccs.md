# crashes (nj-crashes): migrate public data S3 → R2 (HCCS)

Follow the shared **playbook**: `$c/hccs/path/specs/s3-to-r2-hccs-playbook.md`
(reference impl: `path`, commits `4928858` + `adc022f`). This file is crashes'
deltas. **The most complex of the three** — large data + a Worker + a reproc
pipeline — so investigate before executing.

## Provisioned (HCCS, 2026-09-10)

Target bucket created + made public in the HCCS CF account. **Note the HCCS
bucket is named `crashes`** (bare, matching sibling `path`/`hbt`), *not*
`nj-crashes` — the `r2://nj-crashes` references below/in the playbook map to
`r2://crashes` in HCCS.

- **CF account:** HCCS `2363642879f18d37d52dca114059937e`
  (`ryanw@hudcostreets.org`).
- **Bucket:** `crashes` — ENAM (Eastern North America), Standard class. Populated
  by cross-account copy from RAC `nj-crashes` (2026-09-11): **1,354 objs / 4.96 GB**,
  parity-verified (`raw/` 4.4 GB + `cells/` 578 MB); zero missing/extra/mismatched.
- **S3 API endpoint:** `https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com/crashes`
- **Public dev URL:** `https://pub-f247f516ae0b422a9bba8ad56c376a8c.r2.dev`
  (managed r2.dev, rate-limited, no caching — same model as nj-crashes'
  `pub-170b5acc…r2.dev`; a custom domain can be added later, decision #1/#4).

### Credentials (least-privilege, all minted; in `.envrc`)

Naming: `R2_<ACCT>_<RO|RW>_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,TOKEN}`. The copy is
**cross-account** (read RAC, write HCCS), so it needs two S3 keys — a single
`aws s3 sync` can't span both; stream via `rclone` (two remotes) or
download→upload on EC2 `e`.

- **`R2_RAC_RO_*`** (RAC `0dcad`) — read the `nj-crashes` **source** during the copy.
- **`R2_HCCS_RW_*`** (HCCS `2363`) — write the `crashes` **target** during the copy.
  **Not** for prod.
- **`R2_HCCS_RO_*`** (HCCS `2363`) — prod read path for **disk-tree-demo**, wired as
  `profile: hccs` in disk-tree's `buckets.yml` (per-bucket profile support landed
  in disk-tree `02a84a6`):
  ```yaml
  - uri: r2://crashes
    endpoint_url: https://2363642879f18d37d52dca114059937e.r2.cloudflarestorage.com
    profile: hccs
  ```
  disk-tree-demo's own bucket (RAC `0dcad`) keeps its RW key under `profile: rac`.

## Deltas

- **Data store:** DVX remotes `s3://nj-crashes/.dvc` (`s3`) **and**
  `s3://nj-crashes/.dvc-reproc` (`reproc`) → **`r2://nj-crashes`** (HCCS). Decide
  whether the `reproc` remote also moves or stays on S3.
- **LARGE data** (README: 2.4 GB `crashes.db` + ~280 MB parquets). Two consequences:
  - **Data move:** the local-mirror round-trip (playbook step 2) is heavy. Prefer
    running the S3→R2 sync **on the EC2 node `e`** (git remote `e:crashes`, likely
    holds the data / bandwidth) rather than a laptop.
  - **HEAD-503 fix does NOT use full-download.** For ~280 MB parquets, keep ranged
    reads — pass a known `byteLength` to skip only the HEAD (playbook step 6, large
    branch). Full-download (the path approach) is only for small files.
- **FE data-loading:** hyparquet via **`asyncBufferFromStore`**; there are already
  some `.r2.dev` refs in `src` (a partial R2 move may exist — audit first). Find the
  store base-URL constant; verify HEAD behavior in the browser.
- **CF Worker — key architectural question:** deploy is a Worker
  (`.github/workflows/cf-worker-errors.yml`, `wrangler.toml`) + `daily.yml`
  reproc. If the Worker already fronts data requests, it could serve R2 via an
  **R2 binding** (server-side, same account) — **no public bucket + custom domain
  needed**, and no CORS/HEAD issue. Decide: bind R2 to the Worker vs. public
  custom-domain reads (playbook steps 3/5). This likely changes the shape of the
  migration for crashes specifically.
- **Domain:** site domain unconfirmed (Worker route). If public custom-domain reads
  are chosen and the domain isn't a CF zone yet, do the playbook's domain-move
  first. (If served via the Worker binding, moot.)
- **CI creds:** repo remote is `e:crashes` (EC2), not GitHub-hosted like path —
  confirm where CI runs (GHA? the runs suggest GH mirror) and where its S3 creds
  live before swapping to an R2 token.
- **disk-tree interplay:** nj-crashes is a demo bucket in `0dcad` — same
  coordination as ctbk (playbook §disk-tree).

## Open decisions (resolve before implementing)

1. **Worker R2 binding vs. public custom domain** for serving blobs — the biggest fork.
2. Does `.dvc-reproc` move to R2 too?
3. Where to run the large S3→R2 sync (EC2 `e`).
4. Blob hostname if public (needs the site domain confirmed + on CF).
