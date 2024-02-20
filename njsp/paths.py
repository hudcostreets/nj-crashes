from os import path
from os.path import join, relpath

from nj_crashes.paths import DATA_DIR, ROOT_DIR, WWW_NJSP

NJSP_DIR = dirname(__file__)

CRASHES_PQT = join(DATA_DIR, 'crashes.pqt')
CRASHES_RELPATH = relpath(CRASHES_PQT, ROOT_DIR)

NJSP_DATA = join(NJSP_DIR, 'data')
DATA_RELPATH = relpath(NJSP_DATA, ROOT_DIR)
PROJECTED_CSV = join(NJSP_DATA, 'projected.csv')

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

S3_CRASH_LOG_PQT = f's3://nj-crashes/{DATA_RELPATH}/crash-log.parquet'


def annual_ytc_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/ptccr_{year % 100:02d}.pdf'


def annual_ytc_relpath(year):
    return f'ptccr_{year % 100:02d}.pdf'


def annual_ytc_path(year):
    return join(ANNUAL_SUMMARIES, annual_ytc_relpath(year))


def annual_ytd_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/swfcs2_{year % 100:02d}.pdf'
