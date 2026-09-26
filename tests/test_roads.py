import pandas as pd
import pyarrow as pa

import duckdb

from njdot.cli.roads import (
    alias_candidates, assign_crashes, crashes_by_sri, entity_table, name_key, point_aliases, road_entities, road_runs, sri_geom, sri_hit, sris,
)


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
        'ROUTE_SUBT': [7] * 5,
        'lon': [-74.0, -74.2, -74.3, -74.01, -74.25],
        'lat': [40.0, 40.2, 40.3, 40.01, 40.25],
    })


def test_sri_geom_renames_sorts_and_drops_ungeocoded():
    rows = geom_rows()
    rows.loc[len(rows)] = {'SRI': 'A', 'MP': 0.3, 'SLD_NAME': 'A AVE', 'Second_Name': '', 'ROUTE_SUBT': 7, 'lon': float('nan'), 'lat': float('nan')}
    out = sri_geom(rows)
    assert out.columns.tolist() == ['sri', 'mp', 'sld_name', 'name', 'subt', 'lon', 'lat']
    assert out[['sri', 'mp', 'name']].values.tolist() == [
        # A's MP 0.1 "A AVENUE" sits between two "A AVE" points → absorbed as a label blip.
        ['A', 0.0, 'A AVE'], ['A', 0.1, 'A AVE'], ['A', 0.2, 'A AVE'], ['B', 0.0, 'B ST'], ['B', 0.1, 'B ST'],
    ]


# West Side Ave, Jersey City in miniature: SRI `WSA1` is "W Side Ave" for MP 0–0.2 then turns onto
# "Duncan Ave"; SRI `WSA2` continues "W Side Ave" north from WSA1's MP 0.2 point; `FAR` is another
# "W Side Ave" ~11 km away. ~163 m per tenth (0.00147° lat).
D = 0.00147


def wsa_geom():
    pts = [
        ('WSA1', 0.0, 'W Side Ave', -74.07, 40.70),
        ('WSA1', 0.1, 'W Side Ave', -74.07, 40.70 + D),
        ('WSA1', 0.2, 'W Side Ave', -74.07, 40.70 + 2 * D),
        ('WSA1', 0.3, 'Duncan Ave', -74.07 + 0.0019, 40.70 + 2 * D),
        ('WSA1', 0.4, 'Duncan Ave', -74.07 + 0.0038, 40.70 + 2 * D),
        ('WSA2', 0.0, 'W Side Ave', -74.07, 40.70 + 2 * D + 0.0002),  # ~22 m from WSA1's MP 0.2
        ('WSA2', 0.1, 'W Side Ave', -74.07, 40.70 + 3 * D),
        ('FAR', 0.0, 'W Side Ave', -74.07, 40.80),
        ('FAR', 0.1, 'W Side Ave', -74.07, 40.80 + D),
    ]
    return sri_geom(pd.DataFrame([
        {'SRI': s, 'MP': mp, 'SLD_NAME': 'WEST SIDE AVE', 'Second_Name': n, 'ROUTE_SUBT': 6, 'lon': lon, 'lat': lat}
        for s, mp, n, lon, lat in pts
    ]))


def test_sri_geom_absorbs_single_point_name_blips():
    rows = pd.DataFrame([
        {'SRI': 'X', 'MP': mp, 'SLD_NAME': 'X ST', 'Second_Name': n, 'ROUTE_SUBT': 7, 'lon': -74.0, 'lat': 40.0 + mp / 100}
        for mp, n in [(0.0, 'W Side Ave'), (0.1, 'Cator Ave'), (0.2, 'Cator Ave'), (0.3, 'Oops St'), (0.4, 'Cator Ave')]
    ] + [{'SRI': 'Y', 'MP': 0.0, 'SLD_NAME': 'Y ST', 'Second_Name': 'Solo St', 'ROUTE_SUBT': 7, 'lon': -74.1, 'lat': 40.1}])
    # X's MP 0.0 (named for the road it starts on) and MP 0.3 blips take a neighbor's name; a
    # single-point SRI keeps its own.
    assert sri_geom(rows)['name'].tolist() == ['Cator Ave'] * 5 + ['Solo St']


def test_name_key():
    assert name_key(pd.Series(['W Side Ave', 'Westside Ave', 'WEST SIDE AVENUE', 'N Arlington Ave'])).tolist() == [
        'WESTSIDEAVE', 'WESTSIDEAVE', 'WESTSIDEAVE', 'NORTHARLINGTONAVE',
    ]


def test_alias_candidates():
    road = pd.Series([
        'US 1 (Tonnelle Avenue)', 'US 1', 'RT 1`', 'I-78 EB', 'DUNCAN AVE / W SIDE AVE', 'W SIDE AVE **',
        None, 'Kennedy Blvd & Sip Ave', 'NJ 440 (Route 440 Connector)',
    ])
    out = alias_candidates(road)
    assert list(zip(out.index, out)) == [
        (0, 'TONNELLE AVE'), (5, 'W SIDE AVE'), (8, 'RT 440 CONNECTOR'),
    ]


def test_road_runs_split_on_name():
    runs, point_run = road_runs(wsa_geom())
    assert runs[['sri', 'name', 'mp_lo', 'mp_hi', 'mp_end']].values.tolist() == [
        ['FAR', 'W Side Ave', 0.0, 0.1, 0.2],
        ['WSA1', 'W Side Ave', 0.0, 0.2, 0.3],
        ['WSA1', 'Duncan Ave', 0.3, 0.4, 0.5],
        ['WSA2', 'W Side Ave', 0.0, 0.1, 0.2],
    ]
    assert point_run.tolist() == [0, 0, 1, 1, 1, 2, 2, 3, 3]


def test_road_entities_join_touching_same_name_across_sris():
    runs, _ = road_runs(wsa_geom())
    # FAR (sri 'FAR' sorts first) → 0; WSA1's W Side Ave + WSA2 → 1; Duncan Ave → 2.
    assert road_entities(runs).tolist() == [0, 1, 2, 1]


def wsa_runs():
    geom = wsa_geom()
    runs, point_run = road_runs(geom)
    runs['entity'] = road_entities(runs)
    return geom, runs, point_run


def test_assign_crashes_uses_run_intervals():
    _, runs, _ = wsa_runs()
    by_sri = pd.DataFrame([
        crash(1, 'WSA1', 0.25, '2020-01-01'),  # [0.0, 0.3) → W Side Ave
        crash(2, 'WSA1', 0.30, '2020-01-02'),  # [0.3, 0.5) → Duncan Ave
        crash(3, 'WSA2', 0.05, '2020-01-03'),  # W Side Ave (via WSA2)
        crash(4, 'WSA1', 9.00, '2020-01-04'),  # past every run → on no entity
    ])
    out = assign_crashes(by_sri, runs, duckdb.connect())
    assert out[['entity', 'run', 'id']].values.tolist() == [[1, 1, 1], [1, 3, 3], [2, 2, 2]]


def test_point_aliases_per_run_and_bin():
    geom, runs, point_run = wsa_runs()
    by_entity = assign_crashes(pd.DataFrame(
        [crash(i, 'WSA1', 0.1, '2020-01-01') | {'road': 'WEST SIDE AVENUE'} for i in range(3)]  # == name, abbreviated
        + [crash(10 + i, 'WSA1', 0.1, '2020-01-01') | {'road': 'Route 440 connector'} for i in range(4)]
        + [crash(20 + i, 'WSA1', 0.35, '2020-01-01') | {'road': 'duncan  ave.'} for i in range(3)]  # == name
    ), runs, duckdb.connect())
    out = point_aliases(geom, point_run, by_entity)
    # W Side Ave run (WSA1 MP 0–0.2): "RT 440 CONNECTOR" (4) beats the name itself (3); Duncan Ave's
    # only report is its own name → none; other SRIs have no reports.
    assert [None if pd.isna(x) else x for x in out] == [None, None, 'RT 440 CONNECTOR', 'RT 440 CONNECTOR', 'RT 440 CONNECTOR', None, None, None, None]


def test_entity_table():
    geom, runs, point_run = wsa_runs()
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    by_entity = assign_crashes(pd.DataFrame([
        crash(1, 'WSA1', 0.1, '2020-01-01', severity='f', tk=1) | {'road': 'West Side Avenue'},
        crash(2, 'WSA2', 0.0, '2020-01-02', severity='i') | {'road': 'JFK BLVD'},
        crash(3, 'WSA1', 0.3, '2020-01-03') | {'road': 'Duncan Ave'},
        crash(4, 'WSA2', 0.0, '2020-01-04') | {'road': 'JFK Blvd.'},
        crash(5, 'WSA2', 0.0, '2020-01-05') | {'road': 'US 1 (JFK Boulevard)'},
        crash(6, 'WSA2', 0.0, '2020-01-06') | {'road': 'WESTSIDE AVE'},  # own name, spelled differently
        crash(7, 'WSA2', 0.0, '2020-01-07') | {'road': 'SIP AVE / W SIDE AVE'},  # intersection → dropped
        crash(8, 'WSA2', 0.0, '2020-01-08') | {'road': 'SIP AVE'},  # 1 of 7 < ALIAS_MIN_N
    ]), runs, duckdb.connect())
    out = entity_table(runs, geom, by_entity, duckdb.connect())
    assert out[['entity', 'name', 'route', 'sris', 'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases']].astype(object).where(out.notna(), None).values.tolist() == [
        # `route` only where the SLD name differs after normalizing ("WEST SIDE AVE" == "W Side Ave").
        [0, 'W Side Ave', None, 'FAR', 0, 0, 0, 0, None],
        [1, 'W Side Ave', None, 'WSA1,WSA2', 7, 1, 1, 1, 'JFK BLVD'],
        [2, 'Duncan Ave', 'WEST SIDE AVE', 'WSA1', 1, 0, 0, 0, None],
    ]


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
