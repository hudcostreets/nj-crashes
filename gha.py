#!/usr/bin/env python
from os import makedirs
from os.path import dirname
from sys import stderr

import click
from utz import check, process, run

import njsp_plots
import parse_njsp_xmls


def configure_author(name, email):
    run('git', 'config', '--global', 'user.name', name)
    run('git', 'config', '--global', 'user.email', email)


@click.command()
@click.option('-b', '--branch', 'branches', multiple=True)
@click.option('-c', '--configure-author', 'do_configure_author', is_flag=True)
@click.option('-f', '--force', count=True, help=f'Continue past initial no-op data update')
@click.option('-p', '--push', is_flag=True)
@click.option('-r/-R', '--rebase/--no-rebase', is_flag=True, default=None)
def main(branches, do_configure_author, force, push, rebase):
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

    print("Calling parse_njsp_xmls.main()")
    stderr.write("Calling parse_njsp_xmls.main()\n")
    parse_njsp_xmls.main()

    print("Calling njsp_plots.main()")
    stderr.write("Calling njsp_plots.main()\n")
    njsp_plots.main()

    for nb in ['njsp-plots.ipynb']:
        out = f'out/{nb}'
        makedirs(dirname(out), exist_ok=True)
        run('papermill', nb, out)

    data_changed = not check('git', 'diff', '--quiet', 'HEAD', '--', 'data')
    www_changed = not check('git', 'diff', '--quiet', 'origin/www', '--', 'www')
    do_commit = data_changed or www_changed
    changed_files = [ line[3:] for line in process.lines('git', 'status', '--porcelain') ]
    if changed_files:
        print(f'{len(changed_files)} changed files:')
        for f in changed_files:
            print(f'\t{f}')

    if do_commit:
        commit('GHA: update data/plots')
    else:
        print('No data/plot change found')

    if push:
        if did_commit:
            if rebase is not False:
                # None -> merge, True -> rebase, False -> skip
                run('git', 'config', 'pull.rebase', str(bool(rebase)).lower())
                for branch in branches:
                    run('git', 'pull', 'origin', branch)

            for branch in branches:
                run('git', 'push', 'origin', f'HEAD:{branch}')
        else:
            print('Nothing to push')


if __name__ == '__main__':
    main()
