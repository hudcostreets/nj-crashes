from os.path import join

from nj_crashes import ROOT_DIR
from nj_crashes.paths import PUBLIC_DIR

NJDOT_DIR = join(ROOT_DIR, 'njdot')
DOT_DATA = join(NJDOT_DIR, 'data')
WWW_DOT = join(PUBLIC_DIR, 'njdot')
CNS = f'{WWW_DOT}/with_cns.parquet'
CRASHES_DB = f'{WWW_DOT}/crashes.db'
CC2MC2MN = f'{WWW_DOT}/cc2mc2mn.json'
