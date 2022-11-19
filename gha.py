#!/usr/bin/env python
import click
from utz import check, process, run


nb = 'parse-njsp-xmls.ipynb'
out = f'out/{nb}'


def configure_author(name, email):
    run('git', 'config', '--global', 'user.name', name)
    run('git', 'config', '--global', 'user.email', email)


@click.command()
@click.option('-c', '--configure-author', 'do_configure_author', is_flag=True)
@click.option('-f', '--force', count=True, help=f'1x: continue past initial no-op data update; 2x: commit no-op papermill run (with spurious/timestamp changes to {out})')
@click.option('-p', '--push', is_flag=True)
def main(do_configure_author, force, push):
    run('./refresh-data.sh')
    git_is_clean = check('git', 'diff', '--quiet', 'HEAD')
    if git_is_clean:
        print('No data changes found')
        if force:
            print(f'force={force}; continuing')
        else:
            return

    def commit(msg):
        nonlocal do_configure_author
        if do_configure_author:
            configure_author('GitHub Actions', 'ryan-williams@users.noreply.github.com')
            do_configure_author = False
        run('git', 'commit', '-am', msg)

    if not git_is_clean:
        commit('GHA: update data')

    run('papermill', nb, out)
    changed_files = [ line[3:] for line in process.lines('git', 'status', '--porcelain') ]
    print(f'{len(changed_files)} changed files:')
    for f in changed_files:
        print(f'\t{f}')
    if len(changed_files) == 1 and changed_files[0] == out:
        print('No plot/data changes found')
        if force >= 2:
            print(f'force={force}; continuing')
        else:
            return

    commit('GHA: update data/plots')
    if push:
        run('git', 'push', 'origin')


if __name__ == '__main__':
    main()
