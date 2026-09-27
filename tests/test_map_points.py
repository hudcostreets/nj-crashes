"""The recovered map points sidecar: `njdot roads build` → `crash_recovered_points.parquet` →
`map_base._build_base` (specs/crash-location-recovery.md § "Map / cells integration")."""
from os.path import dirname, join
from types import SimpleNamespace

import duckdb
import numpy as np
import pandas as pd

from njdot.cc2mc2mn import cc2mc2mn
from njdot.cli.roads import build_geom, map_points, place_crashes, prep_crashes
from njdot.loc_recovery import FROM_M
from njdot.map_base import (
    RECOVERED_COLS, RECOVERED_DTYPES, RECOVERED_KEY, _build_base, effective_points, read_recovered_points, recovered_points,
    write_recovered_points,
)

FIXTURES = join(dirname(__file__), 'data', 'roads')
NA = None


def records(df: pd.DataFrame) -> list[dict]:
    """`df`'s rows as dicts, NA → None, numpy scalars → Python (float32s here are exact binary
    fractions, so they compare equal to the literals)."""
    out = []
    for r in df.astype(object).to_dict('records'):
        out.append({k: None if v is None or (not isinstance(v, (list, tuple)) and pd.isna(v)) else (v.item() if hasattr(v, 'item') else v) for k, v in r.items()})
    return out


def pts(rows: list[tuple], index=None) -> pd.DataFrame:
    """`(lat, lon)` rows (None: no point) → a `lat` / `lon` float32 frame."""
    return pd.DataFrame(
        [(np.nan, np.nan) if r is None else r for r in rows], columns=['lat', 'lon'], index=index,
    ).astype('float32')


def keys(rows: list[tuple]) -> pd.DataFrame:
    """`(id, year, case, dt, road)` → `id` + `RECOVERED_KEY` (cc 9, mc 6, cross street "1ST ST")."""
    df = pd.DataFrame(rows, columns=['id', 'year', 'case', 'dt', 'road'])
    return df.assign(cc=9, mc=6, dt=pd.to_datetime(df['dt']), cross_street='1ST ST').astype({'id': 'float64'})[['id', *RECOVERED_KEY]]


T = '2023-05-01 08:00'
DT = pd.Timestamp(T)


def test_recovered_points_kinds_and_aashto_keys():
    k = keys([
        (1, 2010, 'c1', T, 'MAIN ST'),   # no point → recovered
        (2, 2010, 'c2', T, 'MAIN ST'),   # unchanged
        (3, 2010, 'c3', T, 'MAIN ST'),   # moved → corrected
        (4, 2010, 'c4', T, 'MAIN ST'),   # removed → dropped
        (5, 2010, 'c5', T, 'MAIN ST'),   # none before or after
        # AASHTO (no `id`):
        (NA, 2023, 'a1', T, 'ELM ST'),   # recovered
        (NA, 2023, 'a2', T, 'ELM ST'),   # two crashes, one key, same outcome: once
        (NA, 2023, 'a2', T, 'ELM ST'),
        (NA, 2023, 'a3', T, 'ELM ST'),   # one key, different outcomes: neither
        (NA, 2023, 'a3', T, 'ELM ST'),
        (NA, 2023, 'a3', T, 'OAK ST'),   # same (year, cc, mc, case), another road: its own key
    ])
    before = pts([None, (40.25, -74.25), (40.25, -74.25), (40.25, -74.25), None, None, None, None, None, (40.5, -74.5), None])
    after = pts([(40.5, -74.5), (40.25, -74.25), (40.75, -74.75), None, None, (40.5, -74.0), (40.125, -74.125), (40.125, -74.125), (40.5, -74.5), (40.5, -74.5), (40.625, -74.625)])
    src = pd.Series(['intersection', 'sri_mp', 'route_xs', 'sri_mp', 'none', 'intersection', 'route_xs', 'route_xs', 'intersection', 'sri_mp', 'sri_calib'])
    out = recovered_points(k, before, after, src)
    assert list(out.columns) == RECOVERED_COLS
    assert out.dtypes.astype(str).to_dict() == {c: str(pd.Series(dtype=t).dtype) for c, t in RECOVERED_DTYPES.items()}
    row = dict(cc=9, mc=6)
    assert records(out) == [
        dict(id=1, year=2010, **row, case='c1', dt=None, road=None, cross_street=None, kind='recovered', loc_source='intersection', lat=40.5, lon=-74.5),
        dict(id=3, year=2010, **row, case='c3', dt=None, road=None, cross_street=None, kind='corrected', loc_source='route_xs', lat=40.75, lon=-74.75),
        dict(id=4, year=2010, **row, case='c4', dt=None, road=None, cross_street=None, kind='dropped', loc_source='sri_mp', lat=None, lon=None),
        dict(id=None, year=2023, **row, case='a1', dt=DT, road='ELM ST', cross_street='1ST ST', kind='recovered', loc_source='intersection', lat=40.5, lon=-74.0),
        dict(id=None, year=2023, **row, case='a2', dt=DT, road='ELM ST', cross_street='1ST ST', kind='recovered', loc_source='route_xs', lat=40.125, lon=-74.125),
        dict(id=None, year=2023, **row, case='a3', dt=DT, road='OAK ST', cross_street='1ST ST', kind='recovered', loc_source='sri_calib', lat=40.625, lon=-74.625),
    ]


def map_crash(id, *, ilat=None, ilon=None, olat=None, olon=None, case=None, year=2010, road='MAIN ST') -> dict:
    return {
        'id': id, 'year': year, 'dt': pd.Timestamp(T), 'cc': 9, 'mc': 6, 'case': case or f'c{id}', 'severity': 'p',
        'tk': 0, 'ti': 0, 'pk': 0, 'pi': 0, 'tv': 1, 'olat': olat, 'olon': olon, 'ilat': ilat, 'ilon': ilon,
        'road': road, 'cross_street': '1ST ST', 'route': None, 'sri': None, 'mp': None,
    }


def sidecar(rows: list[dict]) -> pd.DataFrame:
    base = dict(cc=9, mc=6, dt=None, road=None, cross_street=None, loc_source='intersection', lat=None, lon=None)
    return pd.DataFrame([base | r for r in rows])[RECOVERED_COLS].astype(RECOVERED_DTYPES)


def test_build_base_precedence():
    crashes = pd.DataFrame([
        map_crash(1, ilat=40.25, ilon=-74.25),                  # NJDOT's point, no sidecar row
        map_crash(2),                                           # no point; recovered
        map_crash(3, ilat=40.25, ilon=-74.25),                  # corrected
        map_crash(4, ilat=40.25, ilon=-74.25),                  # dropped
        map_crash(5, olat=40.375, olon=-74.375),                # police point; a (stale) recovered row: NJDOT wins
        map_crash(NA, year=2023, case='a1', road='ELM ST'),     # AASHTO, no point; recovered by key
        map_crash(6),                                           # no point, no sidecar row: off the map
        map_crash(NA, year=2023, case='a1', road='OAK ST'),     # AASHTO, same case, another road: no match
        map_crash(7, olat=0.0, olon=0.0),                       # police point outside NJ: none
    ], index=[10, 11, 12, 13, 14, 15, 16, 17, 18]).astype({'id': 'float64', 'ilat': 'float64', 'ilon': 'float64', 'olat': 'float64', 'olon': 'float64', 'mp': 'float64'})
    side = sidecar([
        dict(id=2, year=2010, case='c2', kind='recovered', lat=40.5, lon=-74.5),
        dict(id=3, year=2010, case='c3', kind='corrected', loc_source='route_xs', lat=40.75, lon=-74.75),
        dict(id=4, year=2010, case='c4', kind='dropped', loc_source='sri_mp'),
        dict(id=5, year=2010, case='c5', kind='recovered', lat=40.5, lon=-74.5),
        dict(id=NA, year=2023, case='a1', dt=pd.Timestamp(T), road='ELM ST', cross_street='1ST ST', kind='recovered', lat=40.625, lon=-74.625),
    ])
    out = _build_base(crashes, keep_severities=set(), recovered=side)
    assert out.index.tolist() == [10, 11, 12, 14, 15]
    assert records(out[['case', 'lat', 'lon', 'geocode_src']]) == [
        dict(case='c1', lat=40.25, lon=-74.25, geocode_src='interpolated'),
        dict(case='c2', lat=40.5, lon=-74.5, geocode_src='recovered'),
        dict(case='c3', lat=40.75, lon=-74.75, geocode_src='corrected'),
        dict(case='c5', lat=40.375, lon=-74.375, geocode_src='original'),
        dict(case='a1', lat=40.625, lon=-74.625, geocode_src='recovered'),
    ]
    # Without the sidecar: NJDOT's points only (as before).
    plain = _build_base(crashes, keep_severities=set())
    assert records(plain[['case', 'geocode_src']]) == [
        dict(case='c1', geocode_src='interpolated'),
        dict(case='c3', geocode_src='interpolated'),
        dict(case='c4', geocode_src='interpolated'),
        dict(case='c5', geocode_src='original'),
    ]


def test_write_read_recovered_points(tmp_path):
    side = sidecar([
        dict(id=2, year=2010, case='c2', kind='recovered', lat=40.5, lon=-74.5),
        dict(id=4, year=2010, case='c4', kind='dropped', loc_source='sri_mp'),
        dict(id=NA, year=2023, case='a1', dt=pd.Timestamp(T), road='ELM ST', cross_street='1ST ST', kind='recovered', lat=40.625, lon=-74.625),
    ])
    p1, p2 = str(tmp_path / 'a.parquet'), str(tmp_path / 'b.parquet')
    write_recovered_points(side, p1)
    write_recovered_points(side, p2)
    with open(p1, 'rb') as f1, open(p2, 'rb') as f2:
        assert f1.read() == f2.read()
    pd.testing.assert_frame_equal(read_recovered_points(p1), side)
    assert read_recovered_points(str(tmp_path / 'missing.parquet')) is None


def test_map_points_precedence():
    """`map_points`: NJDOT's point unless judged wrong, then recovery's, then a recoded crash's SRI /
    MP on today's network (a stub `Snapper`)."""
    X, Y = 190_000.0, 200_000.0
    lon0, lat0 = FROM_M.transform(X, Y)
    snapper = SimpleNamespace(point=lambda sri, mp: np.array([X, Y]) if (sri, mp) == ('S1', 1.0) else None)
    nan = np.nan
    # The build's crashes after recodes (0 / 1's NJDOT points dropped) and recovery (`fold_recovery`).
    c = pd.DataFrame({
        'ilat': [nan, nan, 40.25, 40.25, nan, nan, 40.25],
        'ilon': [nan, nan, -74.25, -74.25, nan, nan, -74.25],
        'olat': [nan, nan, nan, 40.375, 40.375, nan, nan],
        'olon': [nan, nan, nan, -74.375, -74.375, nan, nan],
        'loc_source': ['sri_mp', 'sri_mp', 'intersection', 'name_only', 'name_only', 'intersection', 'intersection'],
        'sri': ['S1', 'S2', 'X', pd.NA, pd.NA, 'X', 'X'],
        'mp': [1.0, 1.0, 0.5, nan, nan, 0.5, 0.5],
    }).astype({'sri': 'string'})
    # Roads' effective points: recovered ones, and NJDOT's where no recovery point (no row: none).
    latlon = pts([(40.75, -74.75), (40.5, -74.5), (40.125, -74.125), (40.625, -74.625)], index=[2, 5, 6, 0]).drop(index=0)
    placement = dict(
        crashes=c, latlon=latlon, snapper=snapper,
        # 2 / 3: coded towns away, re-located, NJDOT's point out of town.
        far_wrong=np.array([False, False, True, True, False, False, False]),
    )
    k = keys([(i, 2010, f'c{i}', T, 'MAIN ST') for i in range(7)])
    before = pts([(40.0625, -74.0625), (40.0625, -74.0625), (40.25, -74.25), (40.25, -74.25), (40.375, -74.375), None, (40.25, -74.25)])
    recoded = np.array([True, True, False, False, False, False, False])
    out = map_points(k, before, recoded, placement)
    assert records(out[['id', 'kind', 'loc_source', 'lat', 'lon']]) == [
        # Recoded, still on its SRI / MP: that point on today's network.
        dict(id=0, kind='corrected', loc_source='sri_mp', lat=float(np.float32(lat0)), lon=float(np.float32(lon0))),
        # Recoded, its SRI / MP on no line: off the map.
        dict(id=1, kind='dropped', loc_source='sri_mp', lat=None, lon=None),
        # Towns away, re-located: recovery's point.
        dict(id=2, kind='corrected', loc_source='intersection', lat=40.75, lon=-74.75),
        # Towns away, re-located by name only: the (distinct) police point stands.
        dict(id=3, kind='corrected', loc_source='name_only', lat=40.375, lon=-74.375),
        # (4: name only, police point: unchanged, though the road pages drop it.)
        # No point: recovery's.
        dict(id=5, kind='recovered', loc_source='intersection', lat=40.5, lon=-74.5),
        # (6: re-located, but NJDOT's point isn't judged wrong: unchanged.)
    ]


def test_map_points_fixture():
    """The Hudson fixture end to end: the crashes recovery places without an NJDOT point, at the
    points the road pages show; `_build_base` then draws them."""
    con = duckdb.connect()
    cl = pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet'))
    al = pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet'))
    b = build_geom(pd.read_parquet(join(FIXTURES, 'roadway_network.parquet')), cl, al, con)
    crashes = prep_crashes(pd.read_parquet(join(FIXTURES, 'crashes.parquet')))
    k = crashes[['id', *RECOVERED_KEY]]
    before = effective_points(crashes)[['lat', 'lon']]
    by_sri, by_entity = place_crashes(crashes, _build_base(crashes, keep_severities=set()), b, cl, al, con, recover=True)
    out = map_points(k, before, np.zeros(len(crashes), dtype=bool), b.pop('placement'))
    assert out.groupby(['kind', 'loc_source']).size().reset_index().values.tolist() == [['recovered', 'intersection', 19]]
    be = by_entity[by_entity['loc_source'].isin(['intersection', 'route_xs', 'sri_calib']).to_numpy()]
    expected = be[['id', 'lat', 'lon']].sort_values('id').astype({'id': 'Int64', 'lat': 'float32', 'lon': 'float32'}).reset_index(drop=True)
    pd.testing.assert_frame_equal(out[['id', 'lat', 'lon']], expected)
    drawn = _build_base(crashes, keep_severities=set(), recovered=out)
    assert drawn['geocode_src'].value_counts().sort_index().to_dict() == {'interpolated': 263, 'original': 14, 'recovered': 19}
