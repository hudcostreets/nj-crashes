from os.path import exists

import click
from utz import process

from nj_crashes.utils.log import err
from nj_crashes.utils.parallel import njobs_opt
from njdot import crashes, vehicles, occupants, pedestrians, drivers
from njdot.paths import DOT_DATA
from njdot.tbls import Tbl, tbls_opt


# def run_tbl(
#         tbl: Tbl,
#         read_pqt: bool = True,
#         write_pqt: bool = False,
#         pqt_path: str = None,
#         n_jobs: int = 0,
# ):


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
@click.option('-p', '--pqt-path', help=f'Write Parquet to this path (default: {DOT_DATA}/<tbl>.parquet`')
@tbls_opt
def compute_pqt(force_recompute, pqt_path, n_jobs, dry_run, tbls: list[Tbl]):
    for tbl in tbls:
        pqt_path = pqt_path or f'{DOT_DATA}/{tbl}.parquet'
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
