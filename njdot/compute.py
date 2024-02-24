#!/usr/bin/env python

from os import cpu_count

import click
from typing import Optional
from urllib.parse import urlparse
from utz import err

from nj_crashes.utils import sql
from nj_crashes.utils.parallel import njobs_opt
from njdot import crashes, vehicles, occupants, pedestrians, drivers
from njdot.load import crash_idxs, S3_PREFIX
from njdot.paths import DOT_DATA, WWW_DOT
from njdot.tbls import Tbl, tbls_opt


def run_tbl(
        tbl: Tbl,
        input_pqt,
        path,
        replace,
        page_size,
        s3_url,
        no_s3,
        read_pqt: bool = True,
        write_pqt: bool = False,
        n_jobs: int = 0,
):
    kwargs = dict(read_pqt=read_pqt, write_pqt=write_pqt, pqt_path=input_pqt, n_jobs=n_jobs)
    load_fn = {
        'crashes': crashes.load,
        'vehicles': vehicles.load,
        'occupants': occupants.load,
        'pedestrians': pedestrians.load,
        'drivers': drivers.load,
    }[tbl]
    df = load_fn(**kwargs)
    if not path:
        path = f'{WWW_DOT}/{tbl}.db'
    idxs = crash_idxs if tbl == 'crashes' else [('crash_id',)]
    if write_pqt:
        sql.write(
            df=df,
            tbl=tbl,
            db_path=path,
            idxs=idxs,
            rm=not replace,
            replace=replace,
            page_size=page_size,
        )
        if not no_s3:
            s3_url = s3_url or f'{S3_PREFIX}/{tbl}.db'
            from boto3 import client
            s3 = client('s3')
            parsed = urlparse(s3_url)
            err(f'Uploading {path} to {s3_url}')
            s3.upload_file(path, Bucket=parsed.netloc, Key=parsed.path.lstrip('/'))


@click.command
@click.option('-f', '--force-recompute', is_flag=True, help="Force recompute, don't read from existing Parquet")
@click.option('-i', '--input-pqt', help=f'Read from this parquet file (default: {DOT_DATA}/<type>.parquet`')
@njobs_opt
@click.option('-n', '--dry-run', is_flag=True, help="Don't write Parquet or DB, or upload to S3")
@click.option('-r', '--replace', is_flag=True, help='Pass `if_exists="replace"` to `DataFrame.to_sql`')
@click.option('-s', '--page-size', type=int, default=2**16, help='Page size for SQLite DB (default: 2**16)')
@click.option('--s3-url', help=f'Upload to this S3 URL (default: `{S3_PREFIX}/<type>.db')
@click.option('-S', '--no-s3', is_flag=True, help='Do not upload to S3')
@tbls_opt
@click.argument('path', required=False)
def main(force_recompute, input_pqt, n_jobs, dry_run, replace, page_size: int, s3_url: Optional[str], no_s3: bool, tbls: list[Tbl], path):
    kwargs = dict(
        input_pqt=input_pqt,
        read_pqt=not force_recompute,
        write_pqt=not dry_run,
        n_jobs=n_jobs,
        path=path,
        replace=replace,
        page_size=page_size,
        s3_url=s3_url,
        no_s3=no_s3,
    )
    if len(tbls) > 1 and n_jobs != 1:
        if not n_jobs:
            n_jobs = cpu_count()
        from joblib import Parallel, delayed
        Parallel(n_jobs=n_jobs)(delayed(run_tbl)(tbl, **kwargs) for tbl in tbls)
    else:
        for tbl in tbls:
            run_tbl(tbl, **kwargs)


if __name__ == '__main__':
    main()
