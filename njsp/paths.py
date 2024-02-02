from os import path
from os.path import join

from nj_crashes.paths import DATA_DIR, WWW_NJSP

CRASHES_PQT = join(DATA_DIR, 'crashes.pqt')
DATA_NJSP = join(DATA_DIR, 'njsp')
# Tabula template JSONs and NJSP summary PDFs live in this dir
ANNUAL_REPORTS = join(DATA_NJSP, 'annual-reports')
ANNUAL_SUMMARIES = join(DATA_NJSP, 'annual-summaries')
ANNUAL_YTC = join(ANNUAL_REPORTS, 'year-type-county')
MISSING_YTC = join(ANNUAL_YTC, 'missing_ytc.csv')

ANNUAL_SUMMARIES_YT_CSV = path.join(ANNUAL_SUMMARIES, 'year-type.csv')
ANNUAL_SUMMARIES_YTC_CSV = path.join(ANNUAL_SUMMARIES, 'year-type-county.csv')

YTC_CSV = path.join(DATA_NJSP, 'year-type-county.csv')
YTC_PQT = path.join(DATA_NJSP, 'year-type-county.pqt')
YTC_DB = path.join(WWW_NJSP, 'year-type-county.db')
YTC_DB_URI = f'sqlite:///{YTC_DB}'


def annual_ytc_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/ptccr_{year % 100:02d}.pdf'


def annual_ytc_relpath(year):
    return f'ptccr_{year % 100:02d}.pdf'


def annual_ytc_path(year):
    return join(ANNUAL_SUMMARIES, annual_ytc_relpath(year))


def annual_ytd_url(year):
    return f'https://www.nj.gov/njsp/info/fatalacc/pdf/swfcs2_{year % 100:02d}.pdf'
