#!/usr/bin/env python
from os import makedirs
from os.path import dirname

import click
from utz import check, process, run


nb = 'parse-njsp-xmls.ipynb'
out = f'out/{nb}'


def configure_author(name, email):
    run('git', 'config', '--global', 'user.name', name)
    run('git', 'config', '--global', 'user.email', email)


@click.command()
@click.option('-b', '--branch')
@click.option('-c', '--configure-author', 'do_configure_author', is_flag=True)
@click.option('-f', '--force', count=True, help=f'Continue past initial no-op data update')
@click.option('-p', '--push', is_flag=True)
def main(branch, do_configure_author, force, push):
    run('./refresh-data.sh')
    git_is_clean = check('git', 'diff', '--quiet', 'HEAD')
    if git_is_clean:
        print('No data changes found')
        if force:
            print(f'force={force}; continuing')
        else:
            return

    did_commit = False
    def commit(msg, amend=True):
        nonlocal do_configure_author, did_commit
        if do_configure_author:
            configure_author('GitHub Actions', 'ryan-williams@users.noreply.github.com')
            do_configure_author = False
        if did_commit and amend:
            print('Amending commit')
            run('git', 'commit', '--amend', '-am', msg)
        else:
            run('git', 'commit', '-am', msg)
            did_commit = True

    if not git_is_clean:
        commit('GHA: update data')

    makedirs(dirname(out), exist_ok=True)
    run('papermill', nb, out)
    data_changed = not check('git', 'diff', '--quiet', 'HEAD', '--', 'data')
    changed_files = [ line[3:] for line in process.lines('git', 'status', '--porcelain') ]
    if changed_files:
        print(f'{len(changed_files)} changed files:')
        for f in changed_files:
            print(f'\t{f}')

    if data_changed:
        commit('GHA: update data/plots')
    else:
        print('No data changes found')

    if push:
        if did_commit:
            cmd = [ 'git', 'push', 'origin', ]
            if branch:
                cmd += [f'HEAD:{branch}']
            run(*cmd)
        else:
            print('Nothing to push')


if __name__ == '__main__':
    main()
