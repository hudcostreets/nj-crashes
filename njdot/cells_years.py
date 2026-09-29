"""`by_year`: a cell's per-year counts, packed into one TEXT column of the
`cells_s2_l{level}` D1 rollup so the worker can serve any year range from D1
(see specs/cells-d1-years.md; the decoder is `cells-api/src/by-year.ts`).

    by_year := entry (';' entry)*     ascending year, one per year with ≥1 crash
    entry   := YY ':' c0 (',' c)*     YY = year - BASE_YEAR
    c       := '' | [1-9][0-9]*       empty = 0; trailing zero counts dropped

Counts are in `FIELDS` order (most-often-nonzero first, so trailing-zero
trimming bites): e.g. `13:2,1;19:1,,,,1,1,1`.
"""
from typing import Mapping, Sequence

BASE_YEAR = 2000

FIELDS = ('n_vehs', 'n_pdo', 'n_inj_other', 'n_inj_ped', 'n_fatal', 'n_killed', 'n_killed_ped')


def encode_entry(year: int, counts: Mapping[str, int]) -> str:
    """Reference encoder for one `(cell, year)` entry (`entry_sql` must agree)."""
    vals = ['' if counts[f] == 0 else str(counts[f]) for f in FIELDS]
    return f'{year - BASE_YEAR}:' + ','.join(vals).rstrip(',')


def encode(rows: Sequence[tuple[int, Mapping[str, int]]]) -> str:
    """Encode `(year, counts)` rows (any order) as a `by_year` value."""
    return ';'.join(encode_entry(y, c) for y, c in sorted(rows, key=lambda r: r[0]))


def decode(by_year: str) -> dict[int, dict[str, int]]:
    """`by_year` → `{year: {field: count}}` (all `FIELDS` present)."""
    out: dict[int, dict[str, int]] = {}
    for entry in by_year.split(';'):
        yy, _, rest = entry.partition(':')
        vals = rest.split(',') if rest else []
        if len(vals) > len(FIELDS):
            raise ValueError(f'by_year entry {entry!r} has {len(vals)} counts (max {len(FIELDS)})')
        year = BASE_YEAR + int(yy)
        if year in out:
            raise ValueError(f'by_year repeats year {year}: {by_year!r}')
        out[year] = {f: int(vals[i]) if i < len(vals) and vals[i] else 0 for i, f in enumerate(FIELDS)}
    return out


def entry_sql(year_col: str = 'year') -> str:
    """DuckDB expression encoding one `(cell, year)` row whose `FIELDS` are
    integer columns of the same names. `rtrim(…, ',')` drops trailing zero
    counts; it can't eat into `YY:` since that ends in ':'."""
    parts = [f"CASE WHEN {f} = 0 THEN '' ELSE CAST({f} AS VARCHAR) END" for f in FIELDS]
    joined = " || ',' || ".join(parts)
    return f"CAST({year_col} - {BASE_YEAR} AS VARCHAR) || ':' || rtrim({joined}, ',')"
