#!/usr/bin/env python
import json
from os import makedirs
from typing import Union, Optional

import papermill

from njsp.cli.base import command
from utz import env
from utz.plots import PLOT_DISPLAY_IMG


def clean_kv(o, k):
    if k in o:
        del o[k]


def clean_notebook(nb: Union[str, dict], nb_out_path: Optional[str] = None) -> dict:
    if isinstance(nb, str):
        nb_path = nb
        with open(nb_path, 'r') as f:
            nb = json.load(f)
        if nb_out_path is None:
            nb_out_path = nb_path

    for cell in nb['cells']:
        clean_kv(cell, 'id')
        metadata = cell['metadata']
        for k in [ 'execution', 'papermill', 'widgets', ]:
            clean_kv(metadata, k)
    metadata = nb['metadata']
    clean_kv(metadata, 'papermill')

    if nb_out_path:
        with open(nb_out_path, 'w') as f:
            json.dump(nb, f, indent=4)

    return nb


@command
def update_plots():
    nb_path = 'njsp-plots.ipynb'
    env[PLOT_DISPLAY_IMG] = '1'
    out_dir = 'out'
    makedirs(out_dir, exist_ok=True)
    nb_out_path = f'{out_dir}/{nb_path}'
    papermill.execute_notebook(nb_path, nb_out_path)
    clean_notebook(nb_out_path, nb_path)
    return "Update NJSP plots"
