"""`njdot compute cells promote`: versioned D1 import → parity report → activation.

A separate module from `njdot/cli/cells.py` on purpose: the cells build stages
pin `cells.py` in their `git_deps`, so promotion code living there would mark
every build stage stale on each change.
"""
import hashlib
from pathlib import Path

import click
import yaml

from nj_crashes.utils.log import err
from njdot import cells_promote, cells_publish
from njdot.cli.cells import (
    OUT_DIR_DEFAULT,
    R2_BUCKET_DEFAULT,
    R2_PREFIX_DEFAULT,
    S2_SHARD_LEVEL_DEFAULT,
    _committed_pyramid_dir,
    _write_manifest,
    cells,
)
from njdot.paths import ROOT_DIR


def _file_md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 24), b''):
            h.update(chunk)
    return h.hexdigest()


def _committed_db_md5(out_dir: Path) -> str:
    """`cells-s2.db.dvc`'s md5, checked against the local `.db` (promoting
    bytes no commit records would make the D1 set unreproducible)."""
    db, dvc = out_dir / 'cells-s2.db', out_dir / 'cells-s2.db.dvc'
    committed = yaml.safe_load(dvc.read_text())['outs'][0]['md5']
    if not db.exists():
        raise click.ClickException(f'{db} not found; `dvx pull {dvc}` first')
    local = _file_md5(db)
    if local != committed:
        raise click.ClickException(f'{db} md5 {local} != {dvc} md5 {committed}: the local .db is not the committed build')
    return committed


@cells.command('promote')
@click.option('-A', '--no-activate', is_flag=True, envvar='CELLS_PROMOTE_NO_ACTIVATE', help='Import + report + stage the build in R2, but leave `manifest.json` (the live build) alone [env: CELLS_PROMOTE_NO_ACTIVATE]')
@click.option('-b', '--bucket', default=R2_BUCKET_DEFAULT, show_default=True, help='R2 bucket')
@click.option('-F', '--reimport', is_flag=True, help='If the versioned D1 table set exists but doesn\'t match the local .db (an interrupted import), drop and re-import it')
@click.option('-n', '--dry-run', is_flag=True, envvar='CELLS_PROMOTE_DRY_RUN', help='No D1 or R2 writes; report what would happen (parity vs. the local .db if not yet imported) [env: CELLS_PROMOTE_DRY_RUN]')
@click.option('-o', '--out-dir', type=click.Path(path_type=Path), default=OUT_DIR_DEFAULT)
@click.option('-p', '--prefix', default=R2_PREFIX_DEFAULT, show_default=True, help='Cells root prefix in the bucket (the worker\'s `CELLS_PREFIX`)')
@click.option('-r', '--require-parity', is_flag=True, envvar='CELLS_PROMOTE_REQUIRE_PARITY', help='Fail (before activating) if any per-level stat differs from the active table set [env: CELLS_PROMOTE_REQUIRE_PARITY]')
def cells_promote_cmd(no_activate: bool, bucket: str, reimport: bool, dry_run: bool, out_dir: Path, prefix: str, require_parity: bool):
    """Publish a rebuilt `cells-s2.db` + `s2_pyramid`: import the `.db` into D1
    `cells-s2` as a versioned table set `cells_s2_<md5[:8]>_l{N}`, report
    per-level parity against the active set, then push + activate the build
    with that `d1.table_prefix`. Idempotent: an already-imported set (matching
    row counts) isn't re-imported; an already-active build isn't re-activated.

    Needs `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (D1) and R2 S3 creds
    (locally: `infra/hccs-run infra/r2-run njdot compute cells promote …`; on
    Batch: `data/cells/promote.dvc`). See specs/cells-d1-years.md.
    """
    db_md5 = _committed_db_md5(out_dir)
    table_prefix = cells_promote.table_prefix_for(db_md5)
    err(f'cells-s2.db {db_md5} → D1 tables {table_prefix}{{N}}')

    manifest = _write_manifest(out_dir, None, None, S2_SHARD_LEVEL_DEFAULT, table_prefix)
    committed = _committed_pyramid_dir(out_dir)
    if committed is None:
        raise click.ClickException('could not read the `s2_pyramid.dvc` `.dir` listing (local cache or public remote)')
    diff = cells_publish.check_against_dvx(manifest, committed)
    if diff:
        raise click.ClickException(f'{len(diff)} pyramid slot(s) differ from `s2_pyramid.dvc` (e.g. {diff[0]}): the build is not committed')

    db_path = out_dir / 'cells-s2.db'
    root = Path(ROOT_DIR)
    if db_path.resolve() != (root / 'data' / 'cells' / 'cells-s2.db').resolve():
        raise click.ClickException(f'`d1-import.sh` imports data/cells/cells-s2.db, not {db_path}')
    try:
        res = cells_promote.promote(
            d1=cells_promote.WranglerD1(root),
            local=cells_promote.SqliteDb(db_path),
            storage=cells_publish.r2_storage(bucket, prefix),
            manifest=manifest,
            out_dir=out_dir,
            dvx=cells_publish.R2DvxBlobs(bucket, prefix),
            activate=not no_activate,
            dry_run=dry_run,
            reimport=reimport,
            require_parity=require_parity,
        )
    except (cells_promote.ParityError, cells_promote.PartialImportError) as e:
        raise click.ClickException(str(e))
    if res.activation == 'stage':
        err(f'staged; cut over with: njdot compute cells activate -p {prefix} {res.data_version}')
    print(res.data_version)
