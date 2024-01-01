import pandas as pd

from nj_crashes.paths import ROOT_DIR
from nj_crashes.sri.sri_map import SriMap

_mp05 = None


SRI_DB_PATH = f'{ROOT_DIR}/nj_sri_mp.db'
SRI_DB_URL = f'sqlite:///{SRI_DB_PATH}'
SRI_DB_TABLE = 'sri_mp'


def get_mp05():
    global _mp05
    if _mp05 is None:
        _mp05 = pd.read_sql_table(SRI_DB_TABLE, SRI_DB_URL)
        if 'SRI' in _mp05:
            _mp05.columns = _mp05.columns.str.lower()
    return _mp05


def get_mp05_map():
    mp05 = get_mp05()
    return SriMap.load(mp05)
