#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3", "click", "pyyaml", "tqdm", "utz"]
# ///
"""Mirror NJDOT bulk-dump blobs from S3 (DVX cache) → R2 (`raw/` prefix).

Reads `.dvc` files in `njdot/data/<year>/`, looks up each blob in the
DVX cache at `s3://nj-crashes/.dvc/files/md5/<md5[:2]>/<md5[2:]>`, and
streams it to `r2://nj-crashes/raw/<dvc-path-without-.dvc>`. No disk
persistence.

See specs/mirror-bulk-to-r2.md.
"""
import fnmatch
import sys
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from time import time

import boto3
import click
import yaml
from tqdm import tqdm

err = partial(print, file=sys.stderr)

DVC_ROOT = Path('njdot/data')
DEFAULT_YEARS = '2022,2023'
DEFAULT_INCLUDE = '*.zip,*.pqt,*.txt'
DEFAULT_BUCKET = 'nj-crashes'
DEFAULT_PREFIX = 'raw/'
DEFAULT_PROFILE = 'cf'


@dataclass
class Job:
    dvc_path: Path
    md5: str
    size: int
    src_key: str
    dst_key: str


def _load_jobs(years: list[str], include_globs: list[str], prefix: str) -> list[Job]:
    jobs: list[Job] = []
    for year in years:
        year_dir = DVC_ROOT / year
        if not year_dir.is_dir():
            err(f'  skip year {year}: {year_dir} not present')
            continue
        for dvc_path in sorted(year_dir.glob('*.dvc')):
            data_path = dvc_path.with_suffix('')  # strip ".dvc"
            if not any(fnmatch.fnmatch(data_path.name, g) for g in include_globs):
                continue
            with open(dvc_path) as f:
                doc = yaml.safe_load(f)
            outs = doc.get('outs') or []
            if len(outs) != 1:
                raise RuntimeError(f'{dvc_path}: expected 1 out, got {len(outs)}')
            out = outs[0]
            md5 = out['md5']
            size = out['size']
            src_key = f'.dvc/files/md5/{md5[:2]}/{md5[2:]}'
            dst_key = f'{prefix}{data_path.as_posix()}'
            jobs.append(Job(dvc_path, md5, size, src_key, dst_key))
    return jobs


def _r2_has(r2, bucket: str, key: str, size: int) -> bool:
    try:
        head = r2.head_object(Bucket=bucket, Key=key)
    except r2.exceptions.ClientError:
        return False
    except Exception as e:
        # boto3 raises botocore.exceptions.ClientError; r2.exceptions covers it,
        # but some 404s come through as ClientError on the underlying class.
        msg = str(e)
        if '404' in msg or 'Not Found' in msg or 'NoSuchKey' in msg:
            return False
        raise
    return head['ContentLength'] == size


@click.command()
@click.option('-a', '--all', 'all_years', is_flag=True, help='Mirror every year present in njdot/data/')
@click.option('-b', '--bucket', default=DEFAULT_BUCKET, help='R2 bucket name')
@click.option('-f', '--force', is_flag=True, help='Skip the "already exists with matching size" check; re-upload')
@click.option('-i', '--include-glob', default=DEFAULT_INCLUDE, help='Comma-separated glob filters on the data file name')
@click.option('-n', '--dry-run', is_flag=True, help='Print plan and exit without uploading')
@click.option('-p', '--prefix', default=DEFAULT_PREFIX, help='R2 key prefix')
@click.option('-P', '--profile', default=DEFAULT_PROFILE, help='AWS named profile for R2 (endpoint_url + creds)')
@click.option('-y', '--years', default=DEFAULT_YEARS, help='Comma-separated years (ignored with --all)')
def main(
    all_years: bool,
    bucket: str,
    force: bool,
    include_glob: str,
    dry_run: bool,
    prefix: str,
    profile: str,
    years: str,
):
    if all_years:
        year_dirs = sorted(p.name for p in DVC_ROOT.iterdir() if p.is_dir() and p.name.isdigit())
        years_list = year_dirs
    else:
        years_list = [y.strip() for y in years.split(',') if y.strip()]
    include_globs = [g.strip() for g in include_glob.split(',') if g.strip()]

    err(f'Years: {years_list}')
    err(f'Globs: {include_globs}')
    err(f'Bucket: {bucket}, prefix: {prefix!r}')

    jobs = _load_jobs(years_list, include_globs, prefix)
    if not jobs:
        err('No matching .dvc files found.')
        return
    total_bytes = sum(j.size for j in jobs)
    err(f'Found {len(jobs)} files, {total_bytes:,} bytes ({total_bytes / 1024 / 1024:.1f} MiB)')

    if dry_run:
        for j in jobs:
            err(f'  {j.dvc_path}  →  s3://{bucket}/{j.dst_key}  ({j.size:,} B; src .dvc/files/md5/{j.md5[:2]}/{j.md5[2:]})')
        err('--dry-run: stopping.')
        return

    s3 = boto3.client('s3')  # default profile
    r2 = boto3.Session(profile_name=profile).client('s3')

    n_uploaded = 0
    n_skipped = 0
    bytes_uploaded = 0
    t0 = time()

    pbar = tqdm(jobs, unit='file', desc='mirror')
    for j in pbar:
        pbar.set_postfix_str(j.dst_key)
        if not force and _r2_has(r2, bucket, j.dst_key, j.size):
            n_skipped += 1
            continue
        body = s3.get_object(Bucket=bucket, Key=j.src_key)['Body'].read()
        if len(body) != j.size:
            raise RuntimeError(f'{j.src_key}: size mismatch (got {len(body):,}, expected {j.size:,})')
        r2.put_object(Bucket=bucket, Key=j.dst_key, Body=body, ContentLength=j.size)
        n_uploaded += 1
        bytes_uploaded += j.size

    elapsed = time() - t0
    err(
        f'Done. uploaded={n_uploaded}, skipped={n_skipped}, '
        f'bytes={bytes_uploaded:,} ({bytes_uploaded / 1024 / 1024:.1f} MiB), '
        f'elapsed={elapsed:.1f}s'
    )


if __name__ == '__main__':
    main()
