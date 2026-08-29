from os import environ, path
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
COUNTY_HOMICIDES_PQT = join(DATA_DIR, 'county_homicides.parquet')

COUNTY_CITY_CODES_PQT = join(DATA_DIR, 'county-city-codes.parquet')

MUNIS_GEOJSON = join(PUBLIC_DIR, "Municipal_Boundaries_of_NJ.geojson")

# Root for pipeline side-effect artifacts published to S3 (distinct from the
# DVX cache remote, which `.dvc/config` configures). Every `*_S3` constant in
# `njsp/paths.py` / `njdot/paths.py` derives from this, for both the uploads
# and the S3 fallbacks downstream stages read from — so overriding it
# redirects a whole pipeline run away from prod, e.g. a full-DAG reproc audit
# under `NJC_S3=s3://nj-crashes/.reproc`.
S3 = environ.get('NJC_S3', 's3://nj-crashes').rstrip('/')


def relpath(dst: str, src: str = ROOT_DIR) -> str:
    return path.relpath(dst, src)


def resolve(relpath: str) -> str:
    """Resolve a repo-root-relative path to absolute."""
    return join(ROOT_DIR, relpath)
