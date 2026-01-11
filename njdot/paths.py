from os.path import join

from nj_crashes.paths import PUBLIC_DIR, ROOT_DIR
from njdot.tbls import parse_type

NJDOT_DIR = join(ROOT_DIR, 'njdot')
DOT_DATA = join(NJDOT_DIR, 'data')
DOT_DATA_S3 = 's3://nj-crashes/njdot/data'


WWW_DOT = join(PUBLIC_DIR, 'njdot')
CNS = f'{WWW_DOT}/with_cns.parquet'
CRASHES_PQT = f'{DOT_DATA}/crashes.parquet'
CM_PQT = f'{DOT_DATA}/cm.pqt'
CRASHES_DB = f'{WWW_DOT}/crashes.db'
CC2MC2MN = f'{WWW_DOT}/cc2mc2mn.json'

CMYMC_DB = f'{WWW_DOT}/cmymc.db'

MC_PQT = join(DOT_DATA, 'muni_codes.parquet')


def raw_pqt_path(tpe, year, county=None):
    county = county or 'NewJersey'
    tpe = parse_type(tpe)
    return f'{DOT_DATA}/{year}/{county}{year}{tpe}.pqt'
