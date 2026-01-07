from os import path
from os.path import join, dirname

from nj_crashes import paths
from nj_crashes.paths import PUBLIC_DIR, PLOTS_DIR, relpath, DATA_DIR

S3_NJSP = f'{paths.S3}/njsp'
S3_NJSP_DATA = f'{S3_NJSP}/data'

NJSP_DIR = dirname(__file__)
NJSP_DATA = join(NJSP_DIR, 'data')
DATA_RELPATH = relpath(NJSP_DATA)

WWW_NJSP = join(PUBLIC_DIR, 'njsp')
RUNDATE_PATH = join(WWW_NJSP, 'rundate.json')
RUNDATE_RELPATH = relpath(RUNDATE_PATH)
OLD_RUNDATE_PATH = join(PUBLIC_DIR, 'rundate.json')
OLD_RUNDATE_RELPATH = relpath(OLD_RUNDATE_PATH)

CRASHES_PQT = join(NJSP_DATA, 'crashes.parquet')
CRASHES_RELPATH = relpath(CRASHES_PQT)
OLD_CRASHES_PQT = join(DATA_DIR, 'crashes.pqt')
OLD_CRASHES_RELPATH = relpath(OLD_CRASHES_PQT)
CRASHES_PQT_S3 = f'{S3_NJSP_DATA}/crashes.parquet'
CRASHES_DB = join(WWW_NJSP, 'crashes.db')
CRASHES_DB_S3 = f'{S3_NJSP_DATA}/crashes.db'
CRASHES_DB_URI = f'sqlite:///{CRASHES_DB}'

BSKY_CRASH_POSTS_NAME = 'bsky-crash-posts.parquet'
BSKY_CRASH_POSTS = join(NJSP_DATA, BSKY_CRASH_POSTS_NAME)
BSKY_CRASH_POSTS_S3 = f'{S3_NJSP_DATA}/{BSKY_CRASH_POSTS_NAME}'

PROJECTED_CSV = join(WWW_NJSP, 'projected.csv')

# Tabula template JSONs and NJSP summary PDFs live in this dir
ANNUAL_REPORTS = join(NJSP_DATA, 'annual-reports')
ANNUAL_SUMMARIES = join(NJSP_DATA, 'annual-summaries')
ANNUAL_YTC = join(ANNUAL_REPORTS, 'year-type-county')
MISSING_YTC = join(ANNUAL_YTC, 'missing_ytc.csv')

ANNUAL_SUMMARIES_YT_CSV = path.join(ANNUAL_SUMMARIES, 'year-type.csv')
ANNUAL_SUMMARIES_YTC_CSV = path.join(ANNUAL_SUMMARIES, 'year-type-county.csv')

YTC_CSV = path.join(NJSP_DATA, 'year-type-county.csv')
YTC_PQT = path.join(NJSP_DATA, 'year-type-county.pqt')
YTC_DB = path.join(WWW_NJSP, 'year-type-county.db')
YTC_DB_URI = f'sqlite:///{YTC_DB}'

S3_CRASH_LOG_PQT = f'{S3_NJSP_DATA}/crash-log.parquet'
S3_CRASH_LOG_DB = f'{S3_NJSP_DATA}/crash-log.db'

S3_XML_FETCH_LOG = f'{S3_NJSP_DATA}/xml-fetch-log.parquet'

PROJECTED_TOTALS_PATH = join(PLOTS_DIR, 'projected_totals.json')

PROJECTED_TOTALS_RELPATH = relpath(PROJECTED_TOTALS_PATH)

MC_PQT = join(NJSP_DATA, 'muni_codes.parquet')


def annual_ytc_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/ptccr_{year % 100:02d}.pdf'


def annual_ytc_relpath(year):
    return f'ptccr_{year % 100:02d}.pdf'


def annual_ytc_path(year):
    return join(ANNUAL_SUMMARIES, annual_ytc_relpath(year))


def annual_ytd_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/swfcs2_{year % 100:02d}.pdf'


def fauqstats_relpath(year: int) -> str:
    return f'{paths.DATA_RELPATH}/FAUQStats{year}.xml'
