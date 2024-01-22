#!/usr/bin/env python

from re import fullmatch
from subprocess import check_output, CalledProcessError
from sys import stderr

import click


RGX = r'.*@(?P<sha>[\da-f]{40}).*'


@click.command()
@click.option('-d', '--default', help="Optional fallback (in case the provided <ref> doesn't exist)")
@click.argument('ref', default='origin/gh-pages')
def main(default, ref):
    """Print the SHA of the commit that triggered a given GitHub Pages commit."""
    try:
        msg = check_output(['git', 'log', '-1', '--format=%s', ref, ]).decode().rstrip('\n')
    except CalledProcessError as e:
        if default:
            stderr.write(f"Checking {ref} failed, returning default\n")
            print(default)
            return
        else:
            raise
    m = fullmatch(RGX, msg)
    if not m:
        raise RuntimeError(f"Unrecognized commit message for {ref}: {msg}")
    base_sha = m['sha']
    print(base_sha)


if __name__ == '__main__':
    main()
