from os.path import exists, join, dirname, basename

import click
import pandas as pd
from utz import process

from nj_crashes.utils import sql
from nj_crashes.utils.log import err
from nj_crashes.utils.parallel import njobs_opt
from njdot import crashes, vehicles, occupants, pedestrians, drivers
from njdot.load import CRASH_IDXS
from njdot.paths import DOT_DATA, WWW_DOT, DOT_DATA_S3
from njdot.tbls import Tbl, tbls_opt


@click.group('njdot')
def njdot():
    pass


@njdot.group('compute')
def compute():
    pass


@compute.command('pqt')
@click.option('-f', '--force-recompute', is_flag=True, help="Force recompute, don't read from existing Parquet")
@njobs_opt
@click.option('-n', '--dry-run', is_flag=True, help="Don't write Parquet or DB, or upload to S3")
@click.option('-p', '--pqt-path', 'pqt_path0', help=f'Write Parquet to this path (default: {DOT_DATA}/<tbl>.parquet`')
@tbls_opt
def compute_pqt(force_recompute, pqt_path0, n_jobs, dry_run, tbls: list[Tbl]):
    for tbl in tbls:
        pqt_path = pqt_path0 or f'{DOT_DATA}/{tbl}.parquet'
        if exists(pqt_path):
            if force_recompute:
                err(f"{pqt_path} exists; overwriting")
            else:
                err(f"{pqt_path} exists; use -f/--force-recompute to overwrite")
                continue
        else:
            err(f"{pqt_path} doesn't exist; computing")

        kwargs = dict(read_pqt=False, write_pqt=not dry_run, pqt_path=pqt_path, n_jobs=n_jobs)
        load_fn = {
            'crashes': crashes.load,
            'vehicles': vehicles.load,
            'occupants': occupants.load,
            'pedestrians': pedestrians.load,
            'drivers': drivers.load,
        }[tbl]
        load_fn(**kwargs)

        process.run('dvc', 'add', pqt_path)


def write_db(
        tbl: Tbl,
        db_path: str = None,
        pqt_dir: str = None,
        force_recompute: bool = False,
        dry_run: bool = False,
        replace: bool = False,
        page_size: int = 2**16,
        s3_url: str = None,
        no_s3: bool = False,
):
    db_path = db_path or f'{WWW_DOT}/{tbl}.db'
    do_write_db = True
    if exists(db_path):
        if force_recompute:
            err(f"{db_path} exists; overwriting")
        else:
            err(f"{db_path} exists; use -f/--force-recompute to overwrite")
            do_write_db = False
    else:
        err(f"{db_path} doesn't exist; computing")

    if do_write_db and not dry_run:
        pqt_dir = pqt_dir or DOT_DATA
        pqt_path = join(pqt_dir, f'{tbl}.parquet')
        df = pd.read_parquet(pqt_path)
        idxs = CRASH_IDXS if tbl == 'crashes' else [('crash_id',)]
        sql.write(
            df=df,
            tbl=tbl,
            db_path=db_path,
            idxs=idxs,
            rm=not replace,
            replace=replace,
            page_size=page_size,
        )
        process.run('dvc', 'add', db_path)

    if not no_s3:
        s3_url = s3_url or f'{DOT_DATA_S3}/{tbl}.db'
        err(f'Uploading {db_path} to {s3_url}')
        db_dir = dirname(db_path)
        s3_dir = dirname(s3_url)
        process.run(
            'aws', 's3', 'sync',
            *(('--dryrun',) if dry_run else ()),
            '--exclude', '*',
            '--include', basename(db_path),
            f'{db_dir}/',
            f'{s3_dir}/',
        )


@compute.command('db')
@click.option('-f', '--force-recompute', is_flag=True, help="Force recompute, don't read from existing Parquet")
@njobs_opt
@click.option('-n', '--dry-run', is_flag=True, help="Don't write Parquet or DB, or upload to S3")
@click.option('-d', '--pqt-dir', help=f'Read Parquet files from this directory (default: {DOT_DATA}`')
@click.option('-r', '--replace', is_flag=True, help='Pass `if_exists="replace"` to `DataFrame.to_sql`')
@click.option('-s', '--page-size', type=int, default=2**16, help='Page size for SQLite DB (default: 2**16)')
@click.option('--s3-url', help=f'Upload to this S3 URL (default: `{DOT_DATA_S3}/<tbl>.db')
@click.option('-S', '--no-s3', is_flag=True, help='Do not upload to S3')
@tbls_opt
@click.argument('db-path', required=False)
def compute_db(force_recompute, db_path, n_jobs, dry_run, pqt_dir, replace, page_size, s3_url, no_s3, tbls: list[Tbl]):
    f"""Compute SQLite DB from Parquet files.

    db-path: write SQLite to this path (default: {WWW_DOT}/<tbl>.db'
    """
    kwargs = dict(
        db_path=db_path,
        pqt_dir=pqt_dir,
        force_recompute=force_recompute,
        dry_run=dry_run,
        replace=replace,
        page_size=page_size,
        s3_url=s3_url,
        no_s3=no_s3,
    )
    if len(tbls) > 1 and n_jobs != 1:
        from joblib import Parallel, delayed
        if not n_jobs:
            n_jobs = -1
        Parallel(n_jobs=n_jobs)(
            delayed(write_db)(tbl, **kwargs)
            for tbl in tbls
        )
    else:
        for tbl in tbls:
            write_db(tbl, **kwargs)


# Add rawdata subcommand at end to avoid import ordering issues
try:
    from njdot.rawdata import rawdata
    njdot.add_command(rawdata)
except ImportError:
    pass  # rawdata available as standalone CLI if dependencies missing
