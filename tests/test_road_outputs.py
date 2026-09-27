import json

import numpy as np
import pandas as pd

from njdot.cc2mc2mn import cc2mc2mn
from njdot.road_outputs import (
    canon_words, entity_lengths, entity_slugs, muni_codes, place_label, road_ranks, road_search_index, road_summary,
    search_meta, slug_order, slugify,
)


def na(xs):
    return [None if pd.isna(x) else x for x in xs]


def test_slugify():
    assert [slugify(s) for s in [
        'J F Kennedy Boulevard', "St. Paul's Avenue", 'Luis Muñoz Marin Blvd', 'FR RT 70 WB TO GSP SB', '  ', None,
        'Avenue "C"', '38th Street',
    ]] == [
        'j-f-kennedy-boulevard', 'st-pauls-avenue', 'luis-munoz-marin-blvd', 'fr-rt-70-wb-to-gsp-sb', 'road', 'road',
        'avenue-c', '38th-street',
    ]


def test_muni_codes():
    pairs = [
        (9, 'Jersey City'), (9, 'North Bergen Township'), (13, 'Neptune Township'), (13, 'Neptune City Borough'),
        (14, 'Boonton'), (14, 'Boonton Township'), (7, 'City Of Orange Township'), (7, 'South Orange Village Township'),
        (1, 'Egg Harbor Township'), (11, 'Hopewell Borough'), (11, 'Hopewell Township'),
        (9, 'Nowhere'), (10, 'Hopewell Township'),  # no such muni (in that county) → unresolved
    ]
    assert muni_codes(pairs, cc2mc2mn) == {
        (9, 'Jersey City'): 6, (9, 'North Bergen Township'): 8, (13, 'Neptune Township'): 35, (13, 'Neptune City Borough'): 36,
        (14, 'Boonton'): 1, (14, 'Boonton Township'): 2, (7, 'City Of Orange Township'): 17, (7, 'South Orange Village Township'): 19,
        (1, 'Egg Harbor Township'): 8, (11, 'Hopewell Borough'): 5, (11, 'Hopewell Township'): 6,
    }


def slug_fixture():
    """Entities in Hudson (cc 9): 0 all in Jersey City (mc 6); 1 mostly Jersey City with a 1-in-20
    sliver of Bayonne (mc 1) → still "within one muni"; 2 across Jersey City / Union City (mc 10) →
    county-level; 3 / 4 both "Main Street" in Jersey City (collision, ordered by first run's
    `(sri, mp_lo)`: 4's is first); 5 has no muni-coded points; 6 no county; 7 is a road literally
    named "Main Street 2", whose base slug the collision suffix must skip."""
    ents = pd.DataFrame({
        'entity': [0, 1, 2, 3, 4, 5, 6, 7],
        'name': ['West Side Avenue', 'Sip Avenue', 'J F Kennedy Boulevard', 'Main Street', 'Main Street', 'Ramp', 'NJ 165', 'Main Street 2'],
        'cc': pd.array([9, 9, 9, 9, 9, 9, None, 9], dtype='Int8'),
    })
    runs = pd.DataFrame({
        'entity': [0, 1, 2, 3, 4, 4, 5, 6, 7],
        'sri': ['S0', 'S1', 'S2', 'B', 'C', 'A', 'S5', 'S6', 'S7'],
        'mp_lo': [0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0],
    })
    pts = [(0, 6)] * 3 + [(1, 6)] * 19 + [(1, 1)] + [(2, 6)] * 5 + [(2, 10)] * 5 + [(3, 6)] * 2 + [(4, 6)] * 2 + [(5, -1)] * 2 + [(6, -1)] + [(7, 6)]
    geom = pd.DataFrame({'entity': [e for e, _ in pts]})
    return ents, runs, geom, np.array([m for _, m in pts])


def test_entity_slugs():
    ents, runs, geom, pt_mc = slug_fixture()
    out = entity_slugs(ents, runs, geom, pt_mc, cc2mc2mn)
    assert [(e, s, None if pd.isna(m) else int(m)) for e, s, m in out.values] == [
        (0, 'hudson/jersey-city/west-side-avenue', 6),
        (1, 'hudson/jersey-city/sip-avenue', 6),
        (2, 'hudson/j-f-kennedy-boulevard', None),
        (3, 'hudson/jersey-city/main-street-3', 6),  # "-2" is taken by entity 7's base slug
        (4, 'hudson/jersey-city/main-street', 6),  # first run `('A', 5.0)` < 3's `('B', 0.0)`
        (5, 'hudson/ramp', None),
        (6, 'nj/nj-165', None),
        (7, 'hudson/jersey-city/main-street-2', 6),
    ]
    assert slug_order(out) == {2: 0, 4: 1, 7: 2, 3: 3, 1: 4, 0: 5, 5: 6, 6: 7}


def test_entity_lengths_union_secondary_and_gaps():
    # `A` MP 0–0.2 (5 points), its secondary `A_S` MP 0.1–0.3 (parent MPs; overlaps A's 0.1–0.2),
    # `B` MP 0–0.1 then a 0.5-mi gap (not road) to 0.6–0.65. Muni: `A`'s first two points mc 1, rest mc 2.
    geom = pd.DataFrame({
        'sri': ['A'] * 5 + ['A_S'] * 3 + ['B'] * 4,
        'mp': [0.0, 0.05, 0.1, 0.15, 0.2, 0.1, 0.2, 0.3, 0.0, 0.1, 0.6, 0.65],
        'lon': [-74.0 + 0.00095 * i for i in range(5)] + [-74.0 + 0.0019 * i for i in (1, 2, 3)] + [-74.1, -74.1019, -74.1114, -74.11235],
        'lat': [40.7] * 12,
        'entity': [0] * 8 + [1] * 4,
        'cc': pd.array([9] * 12, dtype='Int8'),
    })
    pt_mc = np.array([1, 1, 2, 2, 2, 2, 2, 2, 6, 6, 6, 6])
    out = entity_lengths(geom, pt_mc, {'A_S': 'A'}, max_gap=0.15, max_jump_m=400)
    assert out['total'].round(3).to_dict() == {0: 0.3, 1: 0.15}
    assert out['county'].round(3).to_dict() == {(0, 9): 0.3, (1, 9): 0.15}
    assert out['muni'].round(3).to_dict() == {(0, 9, 1): 0.1, (0, 9, 2): 0.2, (1, 9, 6): 0.15}


def by_entity_rows():
    rows = [
        # entity, cc, mc, year, dt, severity, tk, ti
        (0, 9, 6, 2020, '2020-01-05', 'f', 2, 1),
        (0, 9, 6, 2020, '2020-01-20', 'i', 0, 2),
        (0, 9, 6, 2020, '2020-03-01', 'i', 0, 1),
        (0, 9, 10, 2021, '2021-07-04', 'p', 0, 0),
        (1, 9, 6, 2020, '2020-01-05', 'p', 0, 0),
        (2, 9, 6, 2020, '2020-02-05', 'p', 0, 0),  # a ramp: never ranked
        (1, 99, 1, 2020, '2020-02-05', 'p', 0, 0),  # Port Authority county code: not an area
    ]
    return pd.DataFrame([
        {'entity': e, 'cc': cc, 'mc': mc, 'year': y, 'dt': pd.Timestamp(dt), 'severity': s, 'tk': tk, 'ti': ti}
        for e, cc, mc, y, dt, s, tk, ti in rows
    ])


def test_road_summary():
    c = by_entity_rows()
    assert road_summary(c).values.tolist() == [
        [0, 2020, 'f', 1, 2, 1], [0, 2020, 'i', 2, 0, 3], [0, 2021, 'p', 1, 0, 0],
        [1, 2020, 'p', 2, 0, 0], [2, 2020, 'p', 1, 0, 0],
    ]
    assert road_summary(c, monthly=True).values.tolist() == [
        [0, 2020, 1, 'f', 1, 2, 1], [0, 2020, 1, 'i', 1, 0, 2], [0, 2020, 3, 'i', 1, 0, 1], [0, 2021, 7, 'p', 1, 0, 0],
        [1, 2020, 1, 'p', 1, 0, 0], [1, 2020, 2, 'p', 1, 0, 0], [2, 2020, 2, 'p', 1, 0, 0],
    ]


def test_road_ranks():
    c = by_entity_rows()
    # Entity 0: 10 more Jersey City crashes → eligible for crashes / mi there (13 crashes, 0.5 mi).
    # Entity 3: 20 Union City crashes (more than 0 statewide, fewer per mile).
    c = pd.concat([
        c,
        pd.DataFrame([c.iloc[4].to_dict() | {'entity': 0}] * 10),
        pd.DataFrame([c.iloc[4].to_dict() | {'entity': 3, 'mc': 10}] * 20),
    ], ignore_index=True)
    ents = pd.DataFrame({
        'entity': [0, 1, 2, 3], 'slug': ['hudson/a', 'hudson/jersey-city/b', 'hudson/c', 'hudson/union-city/d'], 'name': ['A', 'B', 'C', 'D'],
        'route': [None] * 4, 'subt': [5, 7, 8, 5],
    })
    lengths = {
        'county': pd.Series({(0, 9): 1.0, (1, 9): 0.1, (3, 9): 4.0}),
        'muni': pd.Series({(0, 9, 6): 0.5, (0, 9, 10): 0.5, (1, 9, 6): 0.1, (3, 9, 10): 4.0}),
    }
    for s in lengths.values():
        s.index.names = ['entity', 'cc'] if s.index.nlevels == 2 else ['entity', 'cc', 'mc']
    out = road_ranks(c, ents, lengths, top=1)
    assert out.columns.tolist() == [
        'cc', 'mc', 'entity', 'slug', 'name', 'route', 'subt', 'n_crashes', 'n_fatal', 'n_killed', 'length_mi', 'per_mi',
        'rank_crashes', 'rank_fatal', 'rank_killed', 'rank_per_mi',
    ]
    rows = [[na([v])[0] for v in r] for r in out[['cc', 'mc', 'entity', 'n_crashes', 'n_fatal', 'n_killed', 'length_mi', 'per_mi', 'rank_crashes', 'rank_fatal', 'rank_killed', 'rank_per_mi']].values.tolist()]
    assert rows == [
        # Hudson county-wide: entity 3 has the most crashes, entity 0 the most fatal / killed / per mile;
        # entity 1 is outside every top-1, entity 2 is a ramp.
        [9, 0, 3, 20, 0, 0, 4.0, 5.0, 1, None, None, None],
        [9, 0, 0, 14, 1, 2, 1.0, 14.0, None, 1, 1, 1],
        # Jersey City: entity 0's 13 crashes there over its 0.5 mi there.
        [9, 6, 0, 13, 1, 2, 0.5, 26.0, 1, 1, 1, 1],
        # Union City: entity 3; entity 0's 1 crash there ranks nowhere.
        [9, 10, 3, 20, 0, 0, 4.0, 5.0, 1, None, None, 1],
    ]


def test_canon_words():
    assert [canon_words(s) for s in ['W Side Ave', 'ST PAULS AVE', 'Main St', 'St', 'Avenue E', 'Co Rd 514', "Martin Luther King Jr. Blvd"]] == [
        ['west', 'side', 'avenue'], ['saint', 'pauls', 'avenue'], ['main', 'street'], ['street'], ['avenue', 'east'],
        ['county', 'road', '514'], ['martin', 'luther', 'king', 'jr', 'boulevard'],
    ]


def test_place_label():
    assert [place_label(cc, m, cc2mc2mn) for cc, m in [
        (9, 'Jersey City'), (9, 'North Bergen Township · Jersey City'), (9, 'A · B · C'), (9, None), (None, 'X'), (None, None),
    ]] == ['Jersey City, Hudson', 'North Bergen Township · Jersey City, Hudson', 'Hudson County', 'Hudson County', 'X', None]


def test_road_search_index():
    names_idx = pd.DataFrame({
        'name_display': ['West Side Avenue', 'W SIDE AVE', 'West Side Avenue', 'Journal Square'],
        'kind': ['primary', 'alias', 'primary', 'alias'],
        'entity': [5, 5, 7, 9],
        'subt': [7, 7, 7, 5],
        'n_crashes': [880, 880, 259, 27127],
        'lon': [-74.08, -74.08, -74.03, -74.06], 'lat': [40.72, 40.72, 40.80, 40.73],
        'lon_min': [-74.09, -74.09, -74.04, -74.061], 'lat_min': [40.70, 40.70, 40.78, 40.729],
        'lon_max': [-74.07, -74.07, -74.02, -74.059], 'lat_max': [40.74, 40.74, 40.82, 40.731],
    })
    for c in ('lon', 'lat', 'lon_min', 'lat_min', 'lon_max', 'lat_max'):
        names_idx[c] = names_idx[c].astype('float32')
    ents = pd.DataFrame({
        'entity': [5, 7, 9],
        'slug': ['hudson/jersey-city/west-side-avenue', 'hudson/north-bergen/west-side-avenue', 'hudson/j-f-kennedy-boulevard'],
        'name': ['West Side Avenue', 'West Side Avenue', 'J F Kennedy Boulevard'],
        'cc': pd.array([9, 9, 9], dtype='Int8'),
        'munis': ['Jersey City', 'North Bergen Township', 'Jersey City · Bayonne · Union City'],
    })
    out, capped = road_search_index(names_idx, ents, cc2mc2mn, cap=2)
    assert out.columns.tolist() == [
        'token', 'entity', 'slug', 'name', 'matched', 'kind', 'words', 'subt', 'n_crashes', 'cc', 'place',
        'lon', 'lat', 'dx0', 'dy0', 'dx1', 'dy1',
    ]
    # "W SIDE AVE" canonicalizes to the primary's words, but stays a row (it's what the crash reports say).
    assert [na(r) for r in out[['token', 'entity', 'matched', 'kind', 'words', 'place']].values.tolist()] == [
        ['avenue', 5, None, 'primary', 'west side avenue', 'Jersey City, Hudson'],
        ['avenue', 5, 'W SIDE AVE', 'alias', 'west side avenue', 'Jersey City, Hudson'],
        ['journal', 9, 'Journal Square', 'alias', 'journal square', 'Hudson County'],
        ['side', 5, None, 'primary', 'west side avenue', 'Jersey City, Hudson'],
        ['side', 5, 'W SIDE AVE', 'alias', 'west side avenue', 'Jersey City, Hudson'],
        ['square', 9, 'Journal Square', 'alias', 'journal square', 'Hudson County'],
        ['west', 5, None, 'primary', 'west side avenue', 'Jersey City, Hudson'],
        ['west', 5, 'W SIDE AVE', 'alias', 'west side avenue', 'Jersey City, Hudson'],
    ]
    # Each of "avenue" / "side" / "west" had 3 rows; the cap keeps the 2 with the most crashes.
    assert capped == {'avenue': 3, 'side': 3, 'west': 3}
    j = out[out['token'] == 'journal'].iloc[0]
    assert [int(j[c]) for c in ('dx0', 'dy0', 'dx1', 'dy1')] == [-100, -100, 100, 100]
    meta = search_meta(capped)
    assert json.loads(meta['synonyms'])['avenue'] == ['ave', 'av']
    assert json.loads(meta['capped_tokens']) == {'avenue': 3, 'side': 3, 'west': 3}
