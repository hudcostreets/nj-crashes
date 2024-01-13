from os.path import basename, dirname, join

PKG_DIR = dirname(__file__)
ROOT_DIR = dirname(PKG_DIR)

DATA_DIR = join(ROOT_DIR, 'data')
NJDOT_DIR = join(ROOT_DIR, 'njdot')
DOT_DATA = join(NJDOT_DIR, 'data')
SRI_DIR = join(ROOT_DIR, '.sri')
WWW_DIR = join(ROOT_DIR, 'www')
PUBLIC_DIR = join(WWW_DIR, 'public')
WWW_NJSP = join(PUBLIC_DIR, 'njsp')
WWW_DOT = join(PUBLIC_DIR, 'njdot')
PLOTS_DIR = join(PUBLIC_DIR, 'plots')
PKG_NAME = basename(PKG_DIR)
RUNDATE_PATH = join(PUBLIC_DIR, 'rundate.json')
PROJECTED_TOTALS_PATH = join(PLOTS_DIR, 'projected_totals.json')
DB_PATH = join(ROOT_DIR, f'{PKG_NAME}.db')

DB_URI = f'sqlite:///{DB_PATH}'
