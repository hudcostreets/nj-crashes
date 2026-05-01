from os.path import dirname, join

CENSUS_DIR = dirname(__file__)
DATA_DIR = join(CENSUS_DIR, 'data')
RAW_DIR = join(DATA_DIR, 'raw')

NJ_STATE_FIPS = '34'

ACS5_FIRST_YEAR = 2009
ACS5_LAST_YEAR = 2023

POP_VAR_ACS = 'B01003_001E'
POP_VAR_DEC2000 = 'P001001'
