from contextlib import nullcontext

from tempfile import TemporaryDirectory

import json
from papermill import execute_notebook

from typing import Union, Optional
from utz import err


def clean_kv(o, k):
    if k in o:
        del o[k]


def clean_notebook(nb: Union[str, dict], nb_out_path: Optional[str] = None, indent: int = 4) -> dict:
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
            json.dump(nb, f, indent=indent)

    return nb


def execute(nb_path, nb_out_path=None, kernel=None, **kwargs):
    if nb_out_path is None:
        ctx = TemporaryDirectory()
        nb_out_path = f'{ctx.name}/{nb_path}'
    else:
        ctx = nullcontext()
    with ctx:
        err(f"Executing notebook {nb_path} → {nb_out_path}, kernel {kernel}, kwargs {kwargs}")
        execute_notebook(nb_path, nb_out_path, kernel_name=kernel, **kwargs)
        clean_notebook(nb_out_path, nb_path)
