import json
import pandas as pd
from os.path import splitext
from click import option
from tabula import read_pdf

from njdot.data import FIELDS_DIR
from njdot.tbls import types_opt
from .base import rawdata
from .utils import overwrite_opt, dry_run_opt, dry_run_skip


@rawdata.command('parse-fields-pdf', short_help="Parse fields+lengths from one or more schema PDFs, using Tabula")
@option('-2', '--2017', 'version2017', count=True, help='One or more year-versions to process: 0x: 2001, 1x: 2017, 2x: [2001, 2017]')
@overwrite_opt
@dry_run_opt
@types_opt
def parse_fields_pdf(version2017, overwrite, dry_run, types):
    if version2017 == 0:
        versions = [ 2001 ]
    elif version2017 == 1:
        versions = [ 2017 ]
    else:
        versions = [ 2001, 2017 ]

    for tpe in types:
        for version in versions:
            if version == 2017:
                rect = {
                    "x1": 27.54,
                    "x2": 586,
                    "y1": 91.4175,
                    "y2": 750.0825,
                }
                pdf_name = f'2017{tpe}Table.pdf'
            else:
                rect = {
                    "x1": 25.6275,
                    "x2": 587.1375,
                    "y1": 81.4725,
                    "y2": 750.0825,
                }
                pdf_name = f'2001{tpe}Table.pdf'

            pdf_path = f'{FIELDS_DIR}/{pdf_name}'
            json_path = f'{splitext(pdf_path)[0]}.json'
            if dry_run_skip(pdf_path, json_path, dry_run=dry_run, overwrite=overwrite):
                continue

            tbls = read_pdf(pdf_path, area=[ rect[k] for k in [ 'y1', 'x1', 'y2', 'x2', ] ], pages='all',)
            fields = pd.concat(tbls).to_dict('records')
            with open(json_path, 'w') as f:
                json.dump(fields, f, indent=4)
