"""Mirror the map geometry dir to S3.

Was an inline `aws s3 sync map s3://nj-crashes/njdot/map --delete` in
`map_sync.dvc`. A `.dvc` cmd is a literal — it can't follow `$NJC_S3` —
so the destination lived on the wrong side of the config/computation
line: a full-DAG reproc had no way to redirect it away from prod, and
the stage had to be excluded from the audit outright. Keeping the
destination in code (see `nj_crashes.paths.S3`) makes the stage
redirectable, so it no longer needs an exclusion.
"""
import os
import subprocess

import click

from nj_crashes.utils.log import err
from njdot.paths import MAP_DIR, MAP_S3

from .base import njdot


@njdot.group('map')
def map_group():
    """Map geometry artifacts."""


@map_group.command('sync')
@click.option('-D', '--no-delete', is_flag=True, help='Additive sync (skip `--delete`)')
@click.option('-d', '--map-dir', default=MAP_DIR, help=f'Local map dir (default: {MAP_DIR})')
@click.option('-n', '--dry-run', is_flag=True, help='Show what would be uploaded without uploading')
@click.option('-q', '--quiet', is_flag=True, help='`--only-show-errors` (suppress per-file progress)')
@click.option('-u', '--s3-url', default=MAP_S3, help=f'Sync to this S3 URL (default: {MAP_S3})')
def map_sync(no_delete: bool, map_dir: str, dry_run: bool, quiet: bool, s3_url: str):
    """Mirror `map_dir` to `s3_url` (the site's geometry fetches)."""
    cmd = ['aws', 's3', 'sync', map_dir, s3_url]
    if not no_delete:
        cmd.append('--delete')
    if dry_run:
        cmd.append('--dryrun')
    if quiet:
        cmd.append('--only-show-errors')
    err(f'$ {" ".join(cmd)}')
    subprocess.run(cmd, env={**os.environ}, check=True)
