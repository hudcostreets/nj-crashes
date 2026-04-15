"""Unit tests for `njsp.match_njdot` normalization helpers + matcher core."""
import pandas as pd

from njsp.match_njdot import (
    parse_mp_from_location, norm_route, norm_street, street_hints_agree,
    _route_mp_agree, match,
)


def test_parse_mp_from_location():
    assert parse_mp_from_location('Interstate 80 W MP 37.3') == 37.3
    assert parse_mp_from_location('State Highway 70 E MP 55.22') == 55.22
    assert parse_mp_from_location('County 618 E MP 1.5') == 1.5
    assert parse_mp_from_location('Garden State Parkway MP 120') == 120.0
    # Lower-case / spacing variants
    assert parse_mp_from_location('mp 5') == 5.0
    assert parse_mp_from_location('MP5.5') == 5.5
    # Leading-decimal form (NJSP writes e.g. 'MP .77' for sub-1-mile posts)
    assert parse_mp_from_location('County 609 MP .77') == 0.77
    assert parse_mp_from_location('MP.5') == 0.5
    # No MP
    assert parse_mp_from_location('Bergenline Ave') is None
    assert parse_mp_from_location('') is None
    assert parse_mp_from_location(None) is None


def test_norm_route():
    # Numeric strings, with various float/int representations
    assert norm_route('80') == '80'
    assert norm_route(80) == '80'
    assert norm_route('80.0') == '80'
    # Leading zeros stripped
    assert norm_route('009') == '9'
    assert norm_route('0') == '0'  # keep at least one digit
    # Whitespace / case
    assert norm_route(' 444 ') == '444'
    # Empty / null
    assert norm_route(None) is None
    assert norm_route('') is None
    assert norm_route('NaN') is None
    assert norm_route('<NA>') is None
    assert norm_route(float('nan')) is None


def test_norm_street():
    # Abbreviation expansion
    assert norm_street('Orange St') == 'ORANGE STREET'
    assert norm_street('Main Ave') == 'MAIN AVENUE'
    assert norm_street('Riverwood Dr') == 'RIVERWOOD DRIVE'
    # Cross-source equivalence (NJSP hint vs NJDOT road)
    assert norm_street('Orange St E MP 5.2') == norm_street('ORANGE ST MP0.23999')
    assert norm_street('S. Mill Rd E MP 0') == norm_street('SOUTH MILL RD')
    assert norm_street('Broad St') == norm_street('BROAD ST MP1.77')
    assert norm_street('Myrtle Ave') == norm_street('MYRTLE AVE ** MP0.15')
    # Leading street number stripped
    assert norm_street('200 RIVERWOOD DR') == 'RIVERWOOD DRIVE'
    assert norm_street('2361 SH 66') == norm_street('2361 NJ 66')
    # Empty / None
    assert norm_street(None) is None
    assert norm_street('') is None
    assert norm_street('   ') is None


def test_street_hints_agree():
    # Match on NJDOT `road`
    assert street_hints_agree('Orange St E MP 5.2', 'ORANGE ST', None) is True
    # Match on NJDOT `cross_street` when `road` differs
    assert street_hints_agree('Main St', 'Broad St', 'MAIN STREET') is True
    # No match
    assert street_hints_agree('Terminal Ave', 'WESTFIELD AVE', None) is False
    # Empty inputs
    assert street_hints_agree(None, 'ORANGE ST', None) is False
    assert street_hints_agree('Orange St', None, None) is False


def test_route_mp_agree():
    # Exact match
    assert _route_mp_agree('80', 37.3, '80', 37.3) is True
    # Within tolerance
    assert _route_mp_agree('80', 37.3, '80', 37.7) is True
    assert _route_mp_agree('80', 37.3, '80', 38.3) is True  # exactly 1.0
    # Outside tolerance
    assert _route_mp_agree('80', 37.3, '80', 39.0) is False
    # Both MPs missing — ok if routes match
    assert _route_mp_agree('80', None, '80', None) is True
    # One MP missing — fail
    assert _route_mp_agree('80', None, '80', 37.3) is False
    assert _route_mp_agree('80', 37.3, '80', None) is False
    # Different routes
    assert _route_mp_agree('80', 37.3, '78', 37.3) is False
    # Either route missing
    assert _route_mp_agree(None, 37.3, '80', 37.3) is False
    assert _route_mp_agree('80', 37.3, None, 37.3) is False


def _mk_njsp(rows):
    """Build a minimal NJSP-shaped dataframe from per-row dicts."""
    df = pd.DataFrame(rows)
    df['dt'] = pd.to_datetime(df['dt']).dt.tz_localize('US/Eastern')
    df.index.name = 'id'
    df.index = df.index.astype('int16') + 100
    df['ti'] = pd.NA
    df['dk'] = df['ok'] = df['pk'] = df['bk'] = pd.NA
    df['street'] = None
    df['type_source'] = 'xml'
    return df


def _mk_njdot(rows):
    """Build a minimal NJDOT-shaped dataframe from per-row dicts."""
    df = pd.DataFrame(rows)
    df['dt'] = pd.to_datetime(df['dt'])
    df['severity'] = 'f'
    return df


def test_pass_1_exact_match():
    """Pass 1: identical (date, cc, mc) on both sides → match."""
    sp = _mk_njsp([
        {'cc': 1, 'mc': 2, 'dt': '2020-01-15', 'tk': 1, 'location': 'Foo Rd', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 1, 'mc': 2, 'case': 'X1', 'dt': '2020-01-15 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'Foo Rd'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 1
    assert matches.iloc[0]['case'] == 'X1'
    assert residuals.empty


def test_pass_2_cross_mc_route_mp():
    """Pass 2: same (date, cc) different mc, but route+mp align → match."""
    sp = _mk_njsp([
        {'cc': 14, 'mc': 8, 'dt': '2015-03-26', 'tk': 1, 'location': 'Interstate 80 W MP 37.3', 'highway': '80'},
    ])
    do = _mk_njdot([
        {'year': 2015, 'cc': 14, 'mc': 35, 'case': 'X1', 'dt': '2015-03-26 02:00', 'tk': 1, 'route': '80', 'mp': 37.7, 'road': 'I-80'},
    ])
    matches, residuals = match(sp, do, years=range(2015, 2016))
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 2
    assert matches.iloc[0]['mc'] == 35  # NJDOT's mc wins (we record the NJDOT side's PK)


def test_no_spurious_match_when_routes_disagree():
    """Same (date, cc) different mc, but routes don't match → unmatched residuals."""
    sp = _mk_njsp([
        {'cc': 14, 'mc': 8, 'dt': '2015-03-26', 'tk': 1, 'location': 'Interstate 80 W MP 37.3', 'highway': '80'},
    ])
    do = _mk_njdot([
        {'year': 2015, 'cc': 14, 'mc': 35, 'case': 'X1', 'dt': '2015-03-26 02:00', 'tk': 1, 'route': '78', 'mp': 37.3, 'road': 'I-78'},
    ])
    matches, residuals = match(sp, do, years=range(2015, 2016))
    assert len(matches) == 0
    assert (residuals['side'] == 'njsp').sum() == 1
    assert (residuals['side'] == 'njdot').sum() == 1
    # Both sides share (date, cc) + routes present → categorized as `route_mismatch`
    assert set(residuals['kind']) == {'route_mismatch'}


def test_residual_kind_pd_missing():
    """NJSP-only crash (no NJDOT row on that date) → `pd_missing`."""
    sp = _mk_njsp([
        {'cc': 1, 'mc': 2, 'dt': '2020-01-15', 'tk': 1, 'location': 'Foo Rd', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 5, 'mc': 5, 'case': 'X1', 'dt': '2020-06-01 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'Bar Rd'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 0
    assert residuals[residuals['side'] == 'njsp']['kind'].iloc[0] == 'pd_missing'
    assert residuals[residuals['side'] == 'njdot']['kind'].iloc[0] == 'pd_missing'


def test_pass_5_time_of_day():
    """Same (date, cc, tk), no route info, but dt times within ±3h → pair."""
    sp = _mk_njsp([
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10 08:30', 'tk': 1, 'location': 'Main St', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 16, 'case': 'X1', 'dt': '2020-05-10 10:15', 'tk': 1, 'route': None, 'mp': None, 'road': 'MAIN ST'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    # Pass 1 should fail (same mc but let's double-check this test: same
    # (date, cc, mc, tk_sum) → pass 1 actually matches). Instead set
    # different mc to force pass 5.
    assert len(matches) == 1
    # Pass 1 fires here since (date, cc, mc) match exactly. Make a
    # stricter test for pass 5 in isolation below.


def test_pass_5_cross_mc_no_route():
    """(date, cc) match, different mc, no route, close time → pass 5."""
    sp = _mk_njsp([
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10 08:30', 'tk': 1, 'location': 'Main St', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X1', 'dt': '2020-05-10 10:15', 'tk': 1, 'route': None, 'mp': None, 'road': 'MAIN ST'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 5


def test_pass_5_skips_when_times_too_far():
    """Same (date, cc, tk) but times > ±3h apart AND clearly different
    street names → no match (pass 5 rejects on time, pass 8 rejects on
    street)."""
    sp = _mk_njsp([
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10 01:00', 'tk': 1, 'location': 'Main St', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X1', 'dt': '2020-05-10 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'OTHER ST'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 0


def test_pass_6_pedestrian_decomp():
    """Two same-(date,cc,tk) crashes disambiguated by pk (pedestrians killed)."""
    sp = _mk_njsp([
        # Same date+cc+tk=2, but one crash has 2 peds killed, other has 0.
        # Timestamps far apart so pass 5 can't match.
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10 01:00', 'tk': 2, 'location': 'Main St', 'highway': None},
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10 20:00', 'tk': 2, 'location': 'Other St', 'highway': None},
    ])
    # Set `pk` on NJSP rows (usually NA for pre-2020 but we're 2020)
    sp.loc[sp.index[0], 'pk'] = 2
    sp.loc[sp.index[1], 'pk'] = 0
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X1', 'dt': '2020-05-10 11:00', 'tk': 2, 'pk': 0, 'route': None, 'mp': None, 'road': 'A'},
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X2', 'dt': '2020-05-10 15:00', 'tk': 2, 'pk': 2, 'route': None, 'mp': None, 'road': 'B'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    # Both NJSP rows matched — pk=2 NJSP → X2, pk=0 NJSP → X1
    assert len(matches) == 2
    assert set(matches['pass']) == {6}
    m_by_njsp_id = matches.set_index('njsp_id')['case'].to_dict()
    # NJSP id 100 has pk=2 → should pair with X2 (pk=2)
    assert m_by_njsp_id[100] == 'X2'
    assert m_by_njsp_id[101] == 'X1'


def test_pass_8_street_fuzzy():
    """Same (date, cc), no route, different mc, matching normalized street
    name with tk differing by 1 → pass 8."""
    sp = _mk_njsp([
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10', 'tk': 2, 'location': 'Orange St E MP 5.2', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X1', 'dt': '2020-05-10 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'ORANGE ST MP0.23'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 8


def test_pass_8_skips_different_streets():
    """Same (date, cc) but distinctly different street names → no pass 8 match."""
    sp = _mk_njsp([
        {'cc': 7, 'mc': 16, 'dt': '2020-05-10', 'tk': 2, 'location': 'Terminal Ave', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 7, 'mc': 99, 'case': 'X1', 'dt': '2020-05-10 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'WESTFIELD AVE'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 0


def test_pass_0_manual_match_overrides_heuristic():
    """A manual match entry forces pairing, even when heuristic passes
    would've paired differently or not at all."""
    sp = _mk_njsp([
        # Different cc, different date, different route, different tk —
        # no heuristic pass would match these. Only manual.
        {'cc': 1, 'mc': 2, 'dt': '2020-06-10', 'tk': 1, 'location': 'Main St', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 5, 'mc': 99, 'case': 'MANUAL-X', 'dt': '2020-07-15 03:00', 'tk': 3, 'route': '999', 'mp': None, 'road': 'OTHER ST'},
    ])
    manual = pd.DataFrame([{'njsp_id': 100, 'year': 2020, 'cc': 5, 'mc': 99, 'case': 'MANUAL-X', 'note': 'human review'}])
    matches, residuals = match(sp, do, years=range(2020, 2021), manual_matches=manual)
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 0
    assert matches.iloc[0]['case'] == 'MANUAL-X'


def test_pass_0_skips_unknown_ids():
    """Unknown `njsp_id` or NJDOT PK in manual file → skip with warning,
    don't error."""
    sp = _mk_njsp([
        {'cc': 1, 'mc': 2, 'dt': '2020-01-15', 'tk': 1, 'location': 'Main St', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 1, 'mc': 2, 'case': 'X1', 'dt': '2020-01-15 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'MAIN ST'},
    ])
    # Manual entry with bogus IDs — should be skipped, not raise
    manual = pd.DataFrame([
        {'njsp_id': 99999, 'year': 2020, 'cc': 1, 'mc': 2, 'case': 'X1', 'note': 'bad njsp id'},
        {'njsp_id': 100, 'year': 2020, 'cc': 1, 'mc': 2, 'case': 'NONEXIST', 'note': 'bad njdot PK'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021), manual_matches=manual)
    # Pass 1 should still match the real pair (X1) via heuristics
    assert len(matches) == 1
    assert matches.iloc[0]['pass'] == 1


def test_residual_kind_unresolved():
    """Same date on both sides but no route info → `unresolved`."""
    sp = _mk_njsp([
        {'cc': 1, 'mc': 2, 'dt': '2020-01-15', 'tk': 2, 'location': 'Foo Rd', 'highway': None},
    ])
    do = _mk_njdot([
        {'year': 2020, 'cc': 5, 'mc': 5, 'case': 'X1', 'dt': '2020-01-15 14:00', 'tk': 1, 'route': None, 'mp': None, 'road': 'Bar Rd'},
    ])
    matches, residuals = match(sp, do, years=range(2020, 2021))
    assert len(matches) == 0
    # tk mismatch prevents pass 1 match; shared date but different cc and no
    # route info → unresolved on both sides
    assert residuals[residuals['side'] == 'njsp']['kind'].iloc[0] == 'unresolved'
    assert residuals[residuals['side'] == 'njdot']['kind'].iloc[0] == 'unresolved'
