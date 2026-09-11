"""Cloudflare infrastructure for crashes (see specs/pulumi-cf-infra.md).

Stands up the crashes public stack in the HCCS Cloudflare account:
- R2 bucket `crashes` (imported; created via dashboard 2026-09-10)
- `crashes.hccs.dev` custom domain + CORS + the interim r2.dev managed domain
- All 8 D1 databases (cells-api: cells-s2, tune; crashes-api: crashes, vehicles,
  occupants, pedestrians, cmymc, njsp-crashes) — created here, data migrated in.

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
data_domain = config.get('data_domain') or 'crashes.hccs.dev'
# Worker custom domains can only bind an already-deployed Worker, so they're gated
# until the cells-api/crashes-api Workers are wrangler-deployed into this account.
manage_worker_domains = config.get_bool('manage_worker_domains') is True

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

# ── Public custom domain: crashes.hccs.dev (creates the CNAME on the zone) ──
custom_domain = cf.R2CustomDomain(
    'crashes-hccs-dev',
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
}
d1_dbs = {
    name: cf.D1Database(f'd1-{name}', account_id=account_id, name=name)
    for name in D1
}

# ── Worker custom domains (gated until Workers are deployed in this account) ──
# First-level under hccs.dev so the `*.hccs.dev` Universal SSL cert covers them
# (a two-deep `*.crashes.hccs.dev` would need paid Advanced Cert Manager).
WORKER_DOMAINS = {
    'crashes-cells.hccs.dev': 'crashes-cells-api',
    'crashes-api.hccs.dev':   'crashes-api',
}
if manage_worker_domains:
    for hostname, service in WORKER_DOMAINS.items():
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
    'crashes-api':       'api/',         # D1 crashes/vehicles/occupants/pedestrians/cmymc/njsp-crashes
}

# ── Outputs (feed wrangler.toml bucket_name / database_id) ────────────
pulumi.export('r2_bucket', bucket.name)
pulumi.export('data_domain', data_domain)
pulumi.export('d1_database_ids', {name: db.id for name, db in d1_dbs.items()})
pulumi.export('worker_bindings', D1)
pulumi.export('workers', WORKERS)
