from os.path import dirname, join

CRIME = dirname(__file__)
HOMICIDES_PQT = join(CRIME, 'homicides.parquet')
COUNTY_HOMICIDES_PQT = join(CRIME, 'county-homicides.parquet')
