from os.path import join

from nj_crashes.paths import PUBLIC_DIR, ROOT_DIR
from njdot.tbls import parse_type

NJDOT_DIR = join(ROOT_DIR, 'njdot')
DOT_DATA = join(NJDOT_DIR, 'data')
DOT_DATA_S3 = 's3://nj-crashes/njdot/data'


WWW_DOT = join(PUBLIC_DIR, 'njdot')
WWW_DATA_DOT = join(PUBLIC_DIR, 'data', 'njdot')
CNS = f'{WWW_DOT}/with_cns.parquet'
CRASHES_PQT = f'{DOT_DATA}/crashes.parquet'
OCCUPANTS_PQT = f'{DOT_DATA}/occupants.parquet'
PEDESTRIANS_PQT = f'{DOT_DATA}/pedestrians.parquet'
VEHICLES_PQT = f'{DOT_DATA}/vehicles.parquet'
CM_PQT = f'{DOT_DATA}/cm.pqt'
CRASHES_DB = f'{WWW_DOT}/crashes.db'
CC2MC2MN = f'{WWW_DOT}/cc2mc2mn.json'

CMYMC_DB = f'{WWW_DOT}/cmymc.db'

MC_PQT = join(DOT_DATA, 'muni_codes.parquet')

# AASHTO Crash.csv pipeline outputs (`njdot aashto …` subcmds)
AASHTO_COMBINED_CRASHES = f'{DOT_DATA}/aashto_combined_crashes.parquet'
AASHTO_SUPPLEMENTED_CRASHES = f'{DOT_DATA}/aashto_supplemented_crashes.parquet'
AASHTO_SUPPLEMENTED_OCCUPANTS = f'{DOT_DATA}/aashto_supplemented_occupants.parquet'
AASHTO_SUPPLEMENTED_PEDESTRIANS = f'{DOT_DATA}/aashto_supplemented_pedestrians.parquet'
AASHTO_SUPPLEMENTED_VEHICLES = f'{DOT_DATA}/aashto_supplemented_vehicles.parquet'

# NJSP-derived geocode backfill for NJDOT fatals missing both
# `(olat, olon)` and `(sri, mp)`. Sidecar parquet keyed by
# `(year, cc, mc, case)`; merged in by `load_crashes_with_aashto`.
CRASHES_GEOCODE_BACKFILL = f'{DOT_DATA}/crashes_geocode_backfill.parquet'


def aashto_year_path(year: int, name: str) -> str:
    return f'{DOT_DATA}/{year}/{name}'


def raw_pqt_path(tpe, year, county=None):
    county = county or 'NewJersey'
    tpe = parse_type(tpe)
    return f'{DOT_DATA}/{year}/{county}{year}{tpe}.pqt'
