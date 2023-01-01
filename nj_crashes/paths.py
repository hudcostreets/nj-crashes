from os.path import basename, dirname

PKG_DIR = dirname(__file__)
ROOT_DIR = dirname(PKG_DIR)
WWW_DIR = f'{ROOT_DIR}/www'
PUBLIC_DIR = f'{WWW_DIR}/public'
PLOTS_DIR = f'{PUBLIC_DIR}/plots'
PKG_NAME = basename(PKG_DIR)
RUNDATE_PATH = f'{PUBLIC_DIR}/rundate.json'
DB_PATH = f'{ROOT_DIR}/{PKG_NAME}.db'
DB_URI = f'sqlite:///{DB_PATH}'
