from os.path import dirname

NJDOT_DIR = dirname(__file__)

from . import tbls
from .data import END_YEAR, START_YEAR
from .paths import CRASHES_PQT, WWW_DOT, CRASHES_DB, CC2MC2MN, CNS
from .crashes import Crashes

from .data import Data, START_YEAR, END_YEAR, YEARS, cc2cn, cn2cc
from .cc2mc2mn import cc2mc2mn, denormalize_name, normalize_name
