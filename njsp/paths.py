from os import path
from os.path import join

from nj_crashes.paths import DATA_DIR

CRASHES_PQT = join(DATA_DIR, 'crashes.pqt')
NJSP_DATA = join(DATA_DIR, 'njsp')
# Tabula template JSONs and NJSP summary PDFs live in this dir
NJSP_STATS = join(NJSP_DATA, 'stats')
ANNUAL_REPORTS = join(NJSP_DATA, 'annual-reports')
ANNUAL_YTC = join(ANNUAL_REPORTS, 'year-type-county')
MISSING_YTC = join(ANNUAL_YTC, 'missing_ytc.csv')

YT_CSV = path.join(NJSP_STATS, 'year-type.csv')
YTC_CSV = path.join(NJSP_STATS, 'year-type-county.csv')
