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

    refreshed_years = []
    for year in years:
        try:
            if refresh_annual_summaries(year, kernel=kernel):
                refreshed_years.append(year)
        except Exception as e:
            err(f"Failed to refresh summaries for {year}: {e}")
            err("Continuing (PDF summaries are optional for years 2020+)")

    if refreshed_years:
        return f'Refresh NJSP annual summaries: {",".join(map(str, refreshed_years))}'
    return None
