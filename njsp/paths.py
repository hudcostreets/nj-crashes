from os import path
from os.path import join

from nj_crashes.paths import DATA_DIR

CRASHES_PQT = join(DATA_DIR, 'crashes.pqt')
NJSP_DATA = join(DATA_DIR, 'njsp')
# Tabula template JSONs and NJSP summary PDFs live in this dir
ANNUAL_REPORTS = join(NJSP_DATA, 'annual-reports')
ANNUAL_SUMMARIES = join(NJSP_DATA, 'annual-summaries')
ANNUAL_YTC = join(ANNUAL_REPORTS, 'year-type-county')
MISSING_YTC = join(ANNUAL_YTC, 'missing_ytc.csv')

ANNUAL_SUMMARIES_YT_CSV = path.join(ANNUAL_SUMMARIES, 'year-type.csv')
ANNUAL_SUMMARIES_YTC_CSV = path.join(ANNUAL_SUMMARIES, 'year-type-county.csv')

YTC_CSV = path.join(NJSP_DATA, 'year-type-county.csv')


def annual_ytc_url(year):
    return 'https://www.nj.gov/njsp/info/fatalacc/pdf/ptccr_%02d.pdf' % (year % 100)


def annual_ytd_url(year):
    return 'https://www.nj.gov/njsp/info/fatalacc/pdf/swfcs2_%02d.pdf' % (year % 100)
