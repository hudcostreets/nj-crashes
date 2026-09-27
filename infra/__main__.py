"""Cloudflare infrastructure for crashes (see specs/pulumi-cf-infra.md).

Stands up the crashes public stack in the HCCS Cloudflare account:
- R2 bucket `crashes` (imported; created via dashboard 2026-09-10)
- `crashes.hccs.dev` custom domain + CORS + the interim r2.dev managed domain
- All 8 D1 databases (cells-api: cells-s2, tune; crashes-api: crashes, vehicles,
  occupants, pedestrians, cmymc, njsp-crashes) — created here, data migrated in.
- User-feedback storage (crashes-api `/v1/feedback`): D1 `crashes-feedback`, the
  *private* R2 bucket `crashes-feedback`, and a Turnstile widget.

Worker *scripts* stay wrangler-deployed; their wrangler.toml bindings reference the
resource names/ids Pulumi provisions (exported below). Per-account resource, so the
same program stands up a second copy in any account via a new stack + `account_id`.
"""
import os

import pulumi
import pulumi_cloudflare as cf

config = pulumi.Config()
# account id isn't secret (it's in every dashboard URL / S3 endpoint); plain config
# so it can build the R2 import id below. Provider auth is the ambient CLOUDFLARE_API_TOKEN.
account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or config.require('cloudflare_account_id')
zone_id = config.require('hccs_zone_id')                      # hccs.dev zone (HCCS acct)
data_domain = config.get('data_domain') or 'crashes-data.hccs.dev'
# Worker custom domains can only bind an already-deployed Worker, so they're gated
# until the cells-api/crashes-api Workers are wrangler-deployed into this account.
# `deployed_workers` (comma-separated service names) narrows which domains to create,
# so cells-api's domain can land before crashes-api is seeded/deployed (window 2).
manage_worker_domains = config.get_bool('manage_worker_domains') is True
deployed_workers = {s for s in (config.get('deployed_workers') or '').split(',') if s}

# ── R2 bucket (imported; created via dashboard 2026-09-10) ────────────
bucket = cf.R2Bucket(
    'crashes',
    account_id=account_id,
    name='crashes',
    location='ENAM',  # Eastern North America
    opts=pulumi.ResourceOptions(
        import_=f'{account_id}/crashes/default',
        protect=True,
    ),
)

# ── R2 data domain: crashes-data.hccs.dev ──
# crashes.hccs.dev was handed to the FE Pages project; raw R2 data (map/og/.dvc,
# dvx-pull) lives here. One-label so the zone's Universal SSL covers it (a
# two-label R2 host would need paid Advanced Cert Manager). The FE Pages custom
# domain crashes.hccs.dev is managed on the Pages project (not here yet).
custom_domain = cf.R2CustomDomain(
    'crashes-data-hccs-dev',
    account_id=account_id,
    bucket_name=bucket.name,
    domain=data_domain,
    zone_id=zone_id,
    enabled=True,
    min_tls='1.2',
)

# ── CORS: browser ranged GET/HEAD of parquet/blobs from any origin ────
cors = cf.R2BucketCors(
    'crashes-cors',
    account_id=account_id,
    bucket_name=bucket.name,
    rules=[cf.R2BucketCorsRuleArgs(
        allowed=cf.R2BucketCorsRuleAllowedArgs(
            methods=['GET', 'HEAD'],
            origins=['*'],
            headers=['Range', 'Authorization'],
        ),
        expose_headers=[
            'Accept-Ranges', 'Content-Range', 'Content-Length',
            'Content-Encoding', 'ETag',
        ],
        max_age_seconds=3600,
    )],
)

# NB: the interim r2.dev managed domain (pub-f247f516…r2.dev) is intentionally NOT
# managed here — the provider's R2ManagedDomain can't be destroyed (it lingers in the
# API), and it's already enabled via dashboard. Keep it as-is through the transition;
# disable it manually at RAC retirement.

# ── D1 databases (created here; data migrated via wrangler d1 export/import) ──
# name → the wrangler binding that references it (documentation).
D1 = {
    'cells-s2':     'CELLS_S2_DB',    # cells-api rollup
    'tune':         'TUNE_DB',        # cells-api preference votes (migrate data!)
    'crashes':      'CRASHES_DB',     # crashes-api
    'vehicles':     'VEHICLES_DB',
    'occupants':    'OCCUPANTS_DB',
    'pedestrians':  'PEDESTRIANS_DB',
    'cmymc':        'CMYMC_DB',
    'njsp-crashes': 'NJSP_CRASHES_DB',
    # crashes-api user feedback (`api/migrations/`); never re-imported, unlike the above.
    'crashes-feedback': 'FEEDBACK_DB',
}
d1_dbs = {
    name: cf.D1Database(f'd1-{name}', account_id=account_id, name=name)
    for name in D1
}

# ── User feedback (crashes-api `/v1/feedback`, `api/src/feedback/`) ──
# Screenshots live in their own bucket with NO custom domain / r2.dev URL, so
# nothing in it is publicly addressable (unlike `crashes`, public at
# crashes-data.hccs.dev); the worker serves each via a per-report token.
feedback_bucket = cf.R2Bucket(
    'crashes-feedback',
    account_id=account_id,
    name='crashes-feedback',
    location='ENAM',
)

# Bot check on the feedback form. The site key is public (the worker serves
# it from its `TURNSTILE_SITE_KEY` var); the secret goes to the worker as the
# `TURNSTILE_SECRET` secret (`wrangler secret put`). Covers every *.hccs.dev
# host, the public prod host (CF for SaaS), and the workers.dev preview.
feedback_turnstile = cf.TurnstileWidget(
    'crashes-feedback',
    account_id=account_id,
    name='crashes-feedback',
    mode='managed',
    domains=['hccs.dev', 'crashes.hudcostreets.org', 'crashes-www-dev.hccs-ctbk.workers.dev'],
)

# Worker secrets for crashes-api (+ `--env dev`), set with `wrangler secret put`
# (wrangler owns the Worker scripts, so Pulumi can't attach them):
#   SLACK_FEEDBACK_WEBHOOK  Slack incoming-webhook URL (unset → Slack skipped)
#   FEEDBACK_ADMIN_TOKEN    Bearer token for `GET /v1/feedback` (unset → disabled)
#   TURNSTILE_SECRET        `pulumi stack output turnstile_secret --show-secrets`

# ── Worker custom domains (gated until Workers are deployed in this account) ──
# First-level under hccs.dev so the `*.hccs.dev` Universal SSL cert covers them
# (a two-deep `*.crashes.hccs.dev` would need paid Advanced Cert Manager).
WORKER_DOMAINS = {
    'crashes-cells.hccs.dev':     'crashes-cells-api',
    'crashes-api.hccs.dev':       'crashes-api',
    # Dev tier (`wrangler deploy --env dev`), behind `dev.crashes.hccs.dev`.
    'crashes-cells-dev.hccs.dev': 'crashes-cells-api-dev',
    'crashes-api-dev.hccs.dev':   'crashes-api-dev',
}
if manage_worker_domains:
    for hostname, service in WORKER_DOMAINS.items():
        if deployed_workers and service not in deployed_workers:
            continue
        cf.WorkersCustomDomain(
            f'wcd-{service}',
            account_id=account_id,
            hostname=hostname,
            service=service,
            zone_id=zone_id,
        )

# ── Workers (documentation; wrangler-deployed, bindings reference the above) ──
WORKERS = {
    'crashes-cells-api': 'cells-api/',   # R2 CELLS_BUCKET=crashes + D1 cells-s2,tune; serves /v1/cells,/v1/raw
    'crashes-api':       'api/',         # D1 crashes/vehicles/occupants/pedestrians/cmymc/njsp-crashes/crashes-feedback + R2 FEEDBACK_BUCKET=crashes-feedback
    # `[env.dev]` of the above: same bindings (prod data, read-only use), new code.
    'crashes-cells-api-dev': 'cells-api/ (--env dev)',
    'crashes-api-dev':       'api/ (--env dev)',
}

# ── Outputs (feed wrangler.toml bucket_name / database_id) ────────────
pulumi.export('r2_bucket', bucket.name)
pulumi.export('data_domain', data_domain)
pulumi.export('d1_database_ids', {name: db.id for name, db in d1_dbs.items()})
pulumi.export('worker_bindings', D1)
pulumi.export('workers', WORKERS)
pulumi.export('feedback_bucket', feedback_bucket.name)
pulumi.export('turnstile_sitekey', feedback_turnstile.sitekey)
pulumi.export('turnstile_secret', pulumi.Output.secret(feedback_turnstile.secret))
