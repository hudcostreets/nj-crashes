from njdot.crashes import Crashes


def test_load_hudson_5yrs():
    first_year, last_year = 2017, 2021
    years = list(range(first_year, last_year + 1))
    county = 'HUDSON'
    c = Crashes.load(years=years, county=county)
    lls = c.lls
    assert len(lls) == 62509
