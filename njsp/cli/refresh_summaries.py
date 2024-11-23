import click
from datetime import datetime
from utz import cd, err, process

from nj_crashes.utils.nb import execute
from njsp.cli.base import command
from njsp.paths import ANNUAL_SUMMARIES, annual_ytc_relpath


def refresh_annual_summaries(year, kernel=None):
    with cd(ANNUAL_SUMMARIES):
        nb_path = 'fetch-summaries.ipynb'
        execute(nb_path, kernel=kernel, parameters=dict(force=True, years=f'{year}'))
        pdf_path = annual_ytc_relpath(year)
        if process.check('git', 'diff', '--exit-code', '--', pdf_path):
            err(f"{pdf_path} unchanged, reverting {nb_path}")
            process.run('git', 'checkout', '--', nb_path,)
            return False
        execute('NJSP summary PDFs.ipynb', kernel=kernel, parameters=dict(years=f'{year}'))
    return True


@command
@click.option('-k', '--kernel', default='python3')
@click.argument('years', nargs=-1)
def refresh_summaries(kernel, years):
    """Update NJSP annual summary PDFs (fetch-summaries.ipynb)."""
    if not years:
        year = datetime.now().year
        years = [ year - 1 ]

    refreshed_years = [
        year
        for year in years
        if refresh_annual_summaries(year, kernel=kernel)
    ]
    return f'Refresh NJSP annual summaries: {",".join(map(str, refreshed_years))}'
