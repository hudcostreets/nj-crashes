#!/usr/bin/env python
import click
from utz import check, process, run


@click.command()
@click.option('-c', '--configure-author', is_flag=True)
@click.option('-p', '--push', is_flag=True)
def main(configure_author, push):
    run('./refresh-data.sh')
    if check('git', 'diff', '--quiet', 'HEAD'):
        print('No data changes found')
        return

    if configure_author:
        run('git', 'config', '--global', 'user.name', 'GitHub Actions')
        run('git', 'config', '--global', 'user.email', 'ryan-williams@users.noreply.github.com')

    run('git', 'commit', '-am', 'GHA: update data')

    nb = 'parse-njsp-xmls.ipynb'
    out = f'out/{nb}'
    run('papermill', nb, out)
    changed_files = [ line[3:] for line in process.lines('git', 'status', '--porcelain') ]
    print(f'{len(changed_files)} changed files:')
    for f in changed_files:
        print(f'\t{f}')
    if len(changed_files) == 1 and changed_files[0] == out:
        print('No plot/data changes found')
        return
    run('git', 'commit', '-am', 'GHA: update data/plots')
    if push:
        run('git', 'push')


if __name__ == '__main__':
    main()
