import pandas as pd
import pyarrow as pa

from njdot.cli.roads import crashes_by_sri, sri_geom, sri_hit, sris


def crash(i, sri, mp, dt, severity='p', tk=0):
    return {
        'sri': sri, 'mp': mp, 'id': i, 'year': 2020, 'dt': pd.Timestamp(dt), 'cc': 9, 'mc': 6, 'case': f'c{i}',
        'severity': severity, 'tk': tk, 'ti': 0, 'pk': 0, 'pi': 0, 'tv': 1, 'road': 'RT 1', 'cross_street': 'X',
        'route': 1,
    }


def test_crashes_by_sri_filters_joins_and_sorts():
    crashes = pd.DataFrame([
        crash(1, 'B', 2.0, '2020-01-02'),
        crash(2, '', 1.0, '2020-01-01'),  # empty SRI → dropped
        crash(3, 'A', 5.0, '2020-01-03'),
        crash(4, None, 1.0, '2020-01-01'),  # null SRI → dropped
        crash(5, 'A', 1.5, '2020-01-04'),
        crash(6, 'B', 2.0, '2020-01-01'),  # same (sri, mp) as 1, earlier dt → first
    ], index=[10, 11, 12, 13, 14, 15])
    # Per-table years have int `route`, AASHTO years str: mixed after the concat.
    crashes['route'] = crashes['route'].astype(object)
    crashes.loc[12, 'route'] = '9'
    # `_build_base` output: only geocoded rows (15 is ungeocoded → lat/lon NaN, kept).
    latlon = pd.DataFrame({'lat': [40.1, 40.3, 40.5], 'lon': [-74.1, -74.3, -74.5]}, index=[10, 12, 14])
    out = crashes_by_sri(crashes, latlon)
    assert out[['sri', 'mp', 'id']].values.tolist() == [['A', 1.5, 5], ['A', 5.0, 3], ['B', 2.0, 6], ['B', 2.0, 1]]
    assert out['lat'].tolist()[:2] == [40.5, 40.3]
    assert out['lat'].isna().tolist() == [False, False, True, False]
    assert out['route'].tolist() == ['1', '9', '1', '1']
    assert pa.Table.from_pandas(out, preserve_index=False).schema.field('route').type == pa.string()


def geom_rows():
    return pd.DataFrame({
        'SRI': ['B', 'A', 'A', 'B', 'A'],
        'MP': [0.1, 0.2, 0.0, 0.0, 0.1],
        'SLD_NAME': ['B ST', 'A AVE', 'A AVE', 'B ST', 'A AVENUE'],
        'Second_Name': [''] * 5,
        'ROUTE_SUBT': [1] * 5,
        'lon': [-74.0, -74.2, -74.3, -74.01, -74.25],
        'lat': [40.0, 40.2, 40.3, 40.01, 40.25],
    })


def test_sri_geom_renames_sorts_and_drops_ungeocoded():
    rows = pd.concat([geom_rows(), pd.DataFrame([{
        'SRI': 'A', 'MP': 0.3, 'SLD_NAME': 'A AVE', 'Second_Name': '', 'ROUTE_SUBT': 1, 'lon': None, 'lat': None,
    }])], ignore_index=True)
    out = sri_geom(rows)
    assert out.columns.tolist() == ['sri', 'mp', 'sld_name', 'lon', 'lat']
    assert out[['sri', 'mp']].values.tolist() == [['A', 0.0], ['A', 0.1], ['A', 0.2], ['B', 0.0], ['B', 0.1]]


def test_sri_hit_orders_by_s2_cell():
    # Level-16 S2 order: the two `B` points (SW, near 40.0°N) come first; within
    # the `A` cluster the curve visits MP 0.2 (40.2°N) before 0.0 / 0.1.
    out = sri_hit(sri_geom(geom_rows()))
    assert out[['sri', 'mp']].values.tolist() == [['B', 0.0], ['B', 0.1], ['A', 0.2], ['A', 0.0], ['A', 0.1]]


def test_sris_index():
    geom = sri_geom(geom_rows())
    crashes = pd.DataFrame([
        crash(1, 'A', 0.1, '2020-01-01', severity='f', tk=2),
        crash(2, 'A', 0.2, '2020-01-02', severity='i'),
        crash(3, 'C', 0.2, '2020-01-02', severity='p'),  # SRI absent from geom → not indexed
    ])
    out = sris(geom, crashes)
    assert out.to_dict('records') == [
        {'sri': 'A', 'sld_name': 'A AVE', 'mp_min': 0.0, 'mp_max': 0.2, 'lon_min': -74.3, 'lat_min': 40.2,
         'lon_max': -74.2, 'lat_max': 40.3, 'n_crashes': 2, 'n_fatal': 1, 'n_injury': 1, 'n_killed': 2},
        {'sri': 'B', 'sld_name': 'B ST', 'mp_min': 0.0, 'mp_max': 0.1, 'lon_min': -74.01, 'lat_min': 40.0,
         'lon_max': -74.0, 'lat_max': 40.01, 'n_crashes': 0, 'n_fatal': 0, 'n_injury': 0, 'n_killed': 0},
    ]
