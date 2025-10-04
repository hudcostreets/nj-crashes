import shutil
from zipfile import ZipFile
from utz import err

from njdot.paths import DOT_DATA
from njdot.tbls import types_opt
from .base import rawdata
from .utils import maybe_capemay_space, regions_opt, years_opt, dry_run_skip, overwrite_opt, dry_run_opt


def cmd(*opts, help=None):
    """Decorator to create commands with common options (regions, types, years)."""
    def wrapper(fn):
        decos = (
            rawdata.command(fn.__name__, short_help=help),
            regions_opt,
            types_opt,
            years_opt,
        ) + opts
        for deco in reversed(decos):
            fn = deco(fn)
        return fn
    return wrapper


@cmd(
    overwrite_opt,
    dry_run_opt,
    help='Convert 1 or more {year, county} .zip files (convert each .zip to a single .txt)'
)
def txt(regions, types, years, overwrite, dry_run):
    for region in regions:
        for year in years:
            for typ in types:
                parent_dir = f'{DOT_DATA}/{year}'
                table = typ
                name = f'{parent_dir}/{region}{year}{table}'
                zip_path = f'{name}.zip'
                txt_path = f'{name}.txt'
                if dry_run_skip(zip_path, txt_path, dry_run=dry_run, overwrite=overwrite):
                    continue

                with ZipFile(zip_path, 'r') as zip_ref:
                    namelist = zip_ref.namelist()
                    txt_name = f'{region}{year}{table}.txt'
                    mv = False
                    if txt_name not in namelist:
                        if region == 'CapeMay':
                            txt_name = f'Cape May{year}{table}.txt'
                            mv = True
                            if txt_name not in namelist:
                                raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                        else:
                            raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                    if namelist != [ txt_name ]:
                        err(f"{zip_path}: unexpected namelist {namelist}")
                    print(f'Extracting: {zip_path} → {txt_path}')
                    zip_ref.extract(txt_name, parent_dir)
                    if mv:
                        src = f'{parent_dir}/{txt_name}'
                        print(f'Fixing "Cape ?May" path: {src} → {txt_path}')
                        shutil.move(src, txt_path)
