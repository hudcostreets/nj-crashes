# crashes Cloudflare infra (Pulumi)

Declarative CF stack for crashes — R2 bucket `crashes`, `crashes.hccs.dev` custom
domain + CORS, the interim r2.dev URL, and all 8 D1 databases. See
[`../specs/pulumi-cf-infra.md`](../specs/pulumi-cf-infra.md).

Pattern mirrors `ctbk/infra`: Pulumi (Python), `pulumi-cloudflare`, local
git-committed `state/` (passphrase-encrypted). Pulumi owns resources + bindings;
wrangler stays authoritative for Worker code. AWS reproc infra is separate
(`../batch/infra`).

## Stacks
- **`hccs`** — the HCCS account standup (`account_id` = HCCS `2363…937e`).

Per-stack config: `cloudflare_account_id` (or `CLOUDFLARE_ACCOUNT_ID` env),
`hccs_zone_id` (the `hccs.dev` zone), `data_domain` (default `crashes.hccs.dev`),
`r2_dev_enabled` (default true), `manage_worker_domains` (default false — flip on
once the Workers are deployed in this account).

## Run
```bash
cd infra
python -m venv venv && ./venv/bin/pip install -r requirements.txt
export PULUMI_CONFIG_PASSPHRASE=...            # for the encrypted local state
export CLOUDFLARE_API_TOKEN=$R2_HCCS_RW_TOKEN  # an HCCS-scoped token (R2+D1+Workers)
export CLOUDFLARE_ACCOUNT_ID=2363642879f18d37d52dca114059937e

pulumi stack select hccs   # or: pulumi stack init hccs
pulumi config set hccs_zone_id <hccs.dev zone id>
pulumi preview             # review; the bucket is imported (protect=True)
pulumi up
```

Feed `pulumi stack output d1_database_ids` back into `cells-api/wrangler.toml` +
`api/wrangler.toml` (`database_id`s), then wrangler-deploy the Workers against HCCS.
