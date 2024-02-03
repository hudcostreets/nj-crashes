#!/usr/bin/env python
import click

from njsp.cli.base import command
from njsp.nb import execute


@command
@click.option('-k', '--kernel', default='python3')
def update_projections(kernel):
    nb_path = 'njsp/update-projections.ipynb'
    execute(nb_path, kernel=kernel)
    return "Update NJSP plots"
