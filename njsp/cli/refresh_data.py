from os.path import basename

from datetime import datetime

import click
from utz import process

from .base import command
from ..paths import fauqstats_relpath


def update_years(*years):
    for year in years:
        out_path = fauqstats_relpath(year)
        name = basename(out_path)
        process.run('wget', '-O', out_path, f'https://nj.gov/njsp/info/fatalacc/{name}')
        process.run('git', 'add', out_path)


@command
@click.argument('years', nargs=-1)
def refresh_data(years):
    if not years:
        year = datetime.now().year
        years = [ year - 2, year - 1, year ]
    update_years(*years)
    return 'Refresh NJSP data'
