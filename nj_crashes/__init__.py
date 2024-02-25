from os.path import dirname

NJ_CRASHES_DIR = dirname(__file__)
ROOT_DIR = dirname(NJ_CRASHES_DIR)

from . import colors
from .muni_codes import load_munis_geojson
