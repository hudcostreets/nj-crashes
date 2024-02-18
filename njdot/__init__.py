from os.path import dirname

NJDOT_DIR = dirname(__file__)

from .data import END_YEAR, START_YEAR
from .paths import CRASHES_PQT, WWW_DOT, CRASHES_DB, CMYM_PQT, CMYM_DB, CC2MC2MN, CNS
from .crashes import Crashes

from .data import Data, START_YEAR, END_YEAR, YEARS
