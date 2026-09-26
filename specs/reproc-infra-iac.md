# IaC-ify the reproc/audit Batch+Fargate infrastructure (Pulumi)

Replace `dvx.batch.bootstrap`'s imperative create-if-missing provisioning with a
declarative, per-project-namespaced Pulumi stack. Motivated by the shared-`dvx`
collision that bit us against ctbk (fixed upstream by per-project `prefix`, dvx
`3de35246c`) and by the baked-static-cred smell in the job definition.

## Why (the two smells this closes)

1. **Cross-project collision / TOCTOU.** `dvx.batch` provisions a *single*
   shared set of resources (`dvx` role/CE/queue/jobdef); `bootstrap()`→`submit()`
   is non-atomic, so two projects (or two runs) interleaving run the wrong
   image. Prefix-namespacing (now available) fixes the *naming*; owning the
   resources declaratively fixes the *lifecycle* (state, drift, teardown,
   review).
2. **Baked static creds.** The submit scripts bake `AWS_ACCESS_KEY_ID/SECRET`
   into the job definition's `environment`. A Fargate **task role** removes them
   entirely — the container gets credentials from the ECS metadata endpoint.

## Architecture — Pulumi owns everything; `dvx.batch.submit` only (no bootstrap)

Key fact: `dvx.batch.submit(prefix=…)` does **not** call `bootstrap` — it just
`submit_job`s against `jobQueue=<prefix>`, `jobDefinition=<prefix>`. So Pulumi
can own **all** the resources (including the job def, with a task role and no
baked creds), and the submit path becomes a one-liner against them. No
`bootstrap`, no create-if-missing mutation, and **no further dvx change needed**.

Names Pulumi must create (mirroring `dvx.batch`'s `prefix='nj-crashes'`
derivation, so `submit(prefix='nj-crashes')` finds them):

| Resource | Name |
|---|---|
| Execution role | `nj-crashes-batch-execution` |
| Task role (new) | `nj-crashes-batch-task` |
| Log groups | `/<jobdef>/batch` (`/nj-crashes/batch`, `/nj-crashes-reproc/batch`) |
| Compute env (Fargate Spot) | `nj-crashes-spot` |
| Job queue (spot) | `nj-crashes` |
| Job definitions | `nj-crashes` (x86 audit), `nj-crashes-reproc` (arm64 + GH token) |
| ECR repo (imported, `protect`ed) | `nj-crashes-reproc` |

### Roles (the security win)

- **Execution role** (`nj-crashes-batch-execution`): ECS agent — pulls the ECR
  image, writes logs. `AmazonECSTaskExecutionRolePolicy` + a scoped
  `secretsmanager:GetSecretValue` on the GH-token ARN (Batch injects that secret
  into the container env at start; the *execution* role reads it, not the task
  role).
- **Task role** (`nj-crashes-batch-task`): the identity the *container* runs as.
  Scoped S3 access to the `nj-crashes` bucket (read `.dvc` remote for `dvx pull`,
  write `.audit-scratch/` for `--s3` side-effects). **No static keys anywhere.**

### Job definitions + images (all in committed config)

Stack config `jobdefs` declares one Batch job definition per entry (name ==
the `prefix` that `batch/submit -d` passes to `dvx.batch.submit`, which reads
logs from `/<prefix>/batch`). Each entry has an `arch` and either:

- `ref`: a git SHA on GitHub. Pulumi (`pulumi-docker-build`) builds
  `batch/Dockerfile` with `REF=<ref>` for that arch, pushes
  `nj-crashes-reproc:<ref[:11]>-<arch>` to ECR, and pins the job def to the
  pushed digest; or
- `image`: a prebuilt ECR URI (the x86 audit image, from the manual-build era).

`secrets: true` injects the stack's `secrets` (env var → Secrets Manager secret; the execution role gets read access). A secret is either an existing `arn` or a `name` that Pulumi creates empty; its value is set out of band by `batch/infra/put-secrets`, so it never enters Pulumi state. Every job def also carries the stack's plain `env`, the vcpu/mem `resourceRequirements`, and `executionRoleArn` + `jobRoleArn` (task role).

### Stacks (2026-09-26)

- **`hccs`** (live, HCCS AWS `688066488567`, `AWS_PROFILE=h`): state committed under `batch/infra/state/` (like `infra/`), encrypted with `.envrc`'s `PULUMI_CONFIG_PASSPHRASE`. The repo is public, so the passphrase must be real: the image's ECR login token is a state secret. Data is in HCCS R2: submit with `run -r r2 …` (DVX reads and pushes R2); injected R2 keys + `AWS_ENDPOINT_URL_S3` point boto/`aws` S3 calls at R2; `NJC_S3=s3://crashes/.batch-scratch`. No task-role S3 grants.
- **`dev`** (legacy RAC AWS `006196295121`, `AWS_PROFILE=r`, empty passphrase): state in RAC S3; reach it with `PULUMI_BACKEND_URL=s3://nj-crashes/pulumi/batch`. Being destroyed per `specs/rac-to-hccs.md`.

Each stack's `Pulumi.<stack>.yaml` is its live state (no `pulumi up -c` overrides). Running at a new commit = push it to GitHub, bump the jobdef's `ref`, commit, `pulumi up --stack hccs`. `batch/.dockerignore` keeps the build context to `Dockerfile` + `entrypoint.sh`.

## Submit path (replaces `tmp/*submit*.py` bootstrap calls)

Promote to `batch/`: a submit wrapper that skips `bootstrap` and calls
`dvx.batch.submit(prefix=<jobdef>, queue='nj-crashes', command=[...],
watch=True)`. Image/arch are already baked into the Pulumi job defs, so submit
carries only the command + per-job env overrides (e.g. `NJC_S3`,
`RESULTS_BRANCH`). Reproc adds the GH-token secret via `submit(secrets=…)`
against the execution-role grant Pulumi set up.

## Layout

Self-contained Pulumi project under `batch/infra/` (its own venv to keep
`pulumi-aws` out of the data-pipeline `.venv`):

```
batch/infra/
  Pulumi.yaml          # name: nj-crashes-batch, runtime python, backend file://./state
  Pulumi.hccs.yaml     # HCCS stack config (jobdefs, env, secrets, vcpu/mem)
  Pulumi.dev.yaml      # legacy RAC stack config
  put-secrets          # fill Pulumi-created secrets' values (never in state)
  state/               # committed local backend (hccs)
  __main__.py          # the program
  requirements.txt     # pulumi, pulumi-aws, pulumi-docker-build
```

Networking: default-VPC subnets + default SG (matches `dvx.batch` today; a
dedicated VPC is a later hardening).

## Increments

1. **This spec + scaffold** — Pulumi program + structure, reviewable, no apply.
2. **`pulumi preview`** (read-only) to validate the plan.
3. **`pulumi up`** — stand up the `nj-crashes-*` namespace (ECR repo `import`ed,
   not recreated). One-time.
4. **Promote the submit wrapper** to `batch/`, drop `bootstrap`, drop baked
   creds; re-run the x86 audit through it as the end-to-end validation.
5. **Retire** the shared-`dvx` usage: nothing else here touches it after (4).

## Deferred / follow-ups

- **On-demand queue** (`nj-crashes-od`) — add if a reclaim-immune "final" run is
  wanted (dvx.batch supports it; Pulumi mirrors).
- **Dedicated VPC/SG** instead of default.
- **ctbk adopts the same pattern** (its own `ctbk-*` Pulumi stack) — this spec is
  the template.
- Whether `dvx.batch` should grow a "provision-nothing, submit-only" assertion
  (it already behaves that way; a guard would make the contract explicit).
