"""S2 cell math for the crash-map's S2 grid (see `specs/s2-pyramid.md`).

Two derivation paths, kept in lock-step by `tests/test_s2.py`:

- **Python (`s2sphere`)** — the one per-crash pass that turns (lat, lon) into
  an S2 cell id. Pure-Python and slow, so we run it once (in `cells raw
  --grid s2`) and cache the result in the raw index.
- **duckdb UBIGINT bit-math** (`parent_sql` / `token_sql`) — derives every
  coarser level's parent id + token from that cached base id. Streams the
  per-level group-by so the rollup stays memory-bounded (same reason the H3
  `cells db` reads raw rather than the pyramid). Validated byte-for-byte
  against `s2sphere`, and `s2sphere`'s tokens are in turn validated against
  the client's `nodes2ts` (`www/src/map/s2`) — so a token produced here is
  the exact string the worker range-scans and the client covers.

An S2 cell id is a uint64: 3 face bits, then 2 bits per level down the
Hilbert quadtree, then a trailing "1" marker bit. `parent(level)` clears the
bits below the level's marker and sets that marker. A token is the id as
16-hex-digit lowercase, trailing zeros stripped (`"X"` for id 0).
"""
import numpy as np

# S2 leaf cells live at level 30; every level's marker bit sits at
# `2 * (LEAF_LEVEL - level)`.
LEAF_LEVEL = 30


def _u64(x: int) -> np.uint64:
    return np.uint64(x)


def lsb_for_level(level: int) -> int:
    """Value of the single marker bit for `level` (Python int)."""
    return 1 << (2 * (LEAF_LEVEL - level))


def latlng_to_id(lat: np.ndarray, lon: np.ndarray, level: int) -> np.ndarray:
    """Per-row `s2sphere`: (lat, lon) → S2 cell id (uint64) at `level`.

    The only pure-Python S2 pass in the pipeline; everything coarser is
    derived from this via `parent_id` / `parent_sql`."""
    from s2sphere import CellId, LatLng
    n = len(lat)
    out = np.empty(n, dtype=np.uint64)
    for i in range(n):
        cell = CellId.from_lat_lng(LatLng.from_degrees(float(lat[i]), float(lon[i])))
        out[i] = np.uint64(cell.parent(level).id())
    return out


def parent_id(ids: np.ndarray, level: int) -> np.ndarray:
    """Vectorized uint64 parent: `(id & ~(lsb-1)) | lsb`. Mirrors `parent_sql`."""
    lsb = _u64(lsb_for_level(level))
    return (ids & ~(lsb - _u64(1))) | lsb


def id_to_token(id_u64: int) -> str:
    """S2 cell id (uint64) → token (lowercase hex, trailing zeros stripped)."""
    if int(id_u64) == 0:
        return 'X'
    return format(int(id_u64), '016x').rstrip('0')


def id_to_latlng(id_u64: int) -> tuple[float, float]:
    """S2 cell id → cell-center (lat, lon) in degrees, via `s2sphere`."""
    from s2sphere import CellId
    ll = CellId(int(id_u64)).to_lat_lng()
    return ll.lat().degrees, ll.lng().degrees


def parent_sql(id_expr: str, level: int) -> str:
    """duckdb SQL: parent id (UBIGINT) of `id_expr` at `level`."""
    lsb = lsb_for_level(level)
    return f'((({id_expr}) & ~(CAST({lsb} AS UBIGINT) - 1)) | CAST({lsb} AS UBIGINT))'


def token_sql(id_expr: str) -> str:
    """duckdb SQL: token (TEXT) of a cell-id UBIGINT `id_expr`.

    `hex()` drops leading zeros, so `lpad` back to 16 before stripping the
    trailing zeros the token format omits. (id 0 can't occur for a real
    cell — every cell carries a marker bit — so the `"X"` special case is
    unneeded here.)"""
    return f"rtrim(lpad(lower(hex({id_expr})), 16, '0'), '0')"
