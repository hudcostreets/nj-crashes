from os import path
from os.path import basename, dirname, join

PKG_DIR = dirname(__file__)
ROOT_DIR = dirname(PKG_DIR)

DATA_RELPATH = 'data'
DATA_DIR = join(ROOT_DIR, DATA_RELPATH)
SRI_DIR = join(ROOT_DIR, '.sri')
WWW_DIR = join(ROOT_DIR, 'www')
PUBLIC_DIR = join(WWW_DIR, 'public')
PLOTS_DIR = join(PUBLIC_DIR, 'plots')
PKG_NAME = basename(PKG_DIR)

HOMICIDES_PQT = join(DATA_DIR, 'homicides.parquet')

COUNTY_CITY_CODES_PQT = join(DATA_DIR, 'county-city-codes.parquet')

MUNIS_GEOJSON = join(PUBLIC_DIR, "Municipal_Boundaries_of_NJ.geojson")

BKT = 'nj-crashes'
S3 = f's3://{BKT}'


def relpath(dst: str, src: str = ROOT_DIR) -> str:
    return path.relpath(dst, src)
