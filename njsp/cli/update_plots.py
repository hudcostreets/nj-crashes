#!/usr/bin/env python
import click
from utz import env
from utz.plots import PLOT_DISPLAY_IMG

from njsp.cli.base import command
from njsp.nb import execute


@command
@click.option('-k', '--kernel', default='python3')
def update_plots(kernel):
    nb_path = 'njsp-plots.ipynb'
    env[PLOT_DISPLAY_IMG] = '1'
    execute(nb_path, kernel=kernel)
    return "Update NJSP plots"
